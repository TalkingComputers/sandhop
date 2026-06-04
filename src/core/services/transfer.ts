import pLimit from "p-limit";
import { basename, dirname } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import type { Sandbox } from "../ports/provider.js";
import { randomToken } from "../rand.js";
import { LOW_PRIORITY_SETUP, shellQuote } from "../shell.js";

const CHUNK_BYTES = 90 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 8;

type TransferHost = Pick<
  HostDeps,
  "exists" | "fileSize" | "isDirectory" | "spawnPipe" | "splitFile"
>;

export type TransferCodec = "gzip" | "zstd";

export interface TransferOptions {
  codec: TransferCodec;
  lowPriority?: boolean;
  excludes?: string[];
}

const safeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9.-]/g, "-");

const readCodec = (opts: TransferOptions | undefined): TransferCodec => {
  if (opts === undefined) return "gzip";
  return opts.codec;
};

const makeArchivePath = (
  safe: string,
  id: string,
  codec: TransferCodec,
): string =>
  `/tmp/keepon-${safe}-${id}.${codec === "gzip" ? "tar.gz" : "tar.zst"}`;

const TAR_CREATE_SETUP = [
  "export COPYFILE_DISABLE=1",
  'KEEPON_TAR_MAC_FLAGS=""',
  'case "$(tar --help 2>/dev/null)" in *--no-mac-metadata*) KEEPON_TAR_MAC_FLAGS="--no-mac-metadata";; esac',
].join("; ");

export interface TarCreateOptions {
  isDirectory?: boolean;
  excludes?: string[];
}

const tarSource = (
  path: string,
  isDirectory: boolean,
): { cwd: string; entry: string } =>
  isDirectory
    ? { cwd: path, entry: "." }
    : { cwd: dirname(path), entry: basename(path) };

const tarExcludeArgs = (excludes: string[] | undefined): string =>
  excludes === undefined
    ? ""
    : excludes.map((exclude) => ` --exclude ${shellQuote(exclude)}`).join("");

const tarEntryArg = (entry: string): string =>
  entry === "." ? "." : shellQuote(entry);

export const makeTarGzipCommand = (
  archive: string,
  cwd: string,
  opts?: TarCreateOptions,
): string => {
  const source = tarSource(cwd, opts?.isDirectory !== false);
  return [
    `${TAR_CREATE_SETUP}; tar $KEEPON_TAR_MAC_FLAGS${tarExcludeArgs(opts?.excludes)}`,
    `-czf ${shellQuote(archive)}`,
    `-C ${shellQuote(source.cwd)}`,
    tarEntryArg(source.entry),
  ].join(" ");
};

const makeTarStreamCommand = (
  path: string,
  isDirectory: boolean,
  excludes: string[] | undefined,
): string => {
  const source = tarSource(path, isDirectory);
  return [
    `${TAR_CREATE_SETUP}; tar $KEEPON_TAR_MAC_FLAGS${tarExcludeArgs(excludes)}`,
    "-cf -",
    `-C ${shellQuote(source.cwd)}`,
    tarEntryArg(source.entry),
  ].join(" ");
};

const makeCompressionCommand = (
  codec: TransferCodec,
  localPath: string,
  archive: string,
  isDirectory: boolean,
  excludes: string[] | undefined,
): string => {
  if (codec === "gzip")
    return makeTarGzipCommand(archive, localPath, { isDirectory, excludes });
  return [
    makeTarStreamCommand(localPath, isDirectory, excludes),
    `zstd -T0 -8 --long=27 --check -o ${shellQuote(archive)} -f`,
  ].join(" | ");
};

const makeExtractionCommands = (
  codec: TransferCodec,
  remoteArchive: string,
  sandboxDestDir: string,
  lowPriority: boolean,
): string[] => {
  const runExtract = (cmd: string): string =>
    lowPriority ? `$KEEPON_LOW_PRIORITY sh -lc ${shellQuote(cmd)}` : cmd;
  if (codec === "gzip")
    return [
      `gzip -t ${shellQuote(remoteArchive)}`,
      `mkdir -p ${shellQuote(sandboxDestDir)}`,
      runExtract(
        `tar -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(sandboxDestDir)}`,
      ),
    ];
  return [
    `zstd -t ${shellQuote(remoteArchive)}`,
    `mkdir -p ${shellQuote(sandboxDestDir)}`,
    runExtract(
      `zstd -d --long=27 -c ${shellQuote(remoteArchive)} | tar -xf - -C ${shellQuote(sandboxDestDir)}`,
    ),
  ];
};

export class TransferService {
  readonly host: TransferHost;
  readonly sandbox: Sandbox;

  constructor(host: TransferHost, sandbox: Sandbox) {
    this.host = host;
    this.sandbox = sandbox;
  }

  async send(
    localPath: string,
    sandboxDestPath: string,
    label: string,
    opts?: TransferOptions,
  ): Promise<void> {
    const safe = safeLabel(label);
    const id = randomToken(12);
    const codec = readCodec(opts);
    const isDirectory =
      !this.host.exists(localPath) || this.host.isDirectory(localPath);
    const sandboxDestDir = isDirectory
      ? sandboxDestPath
      : dirname(sandboxDestPath);
    const archive = makeArchivePath(safe, id, codec);
    const prefix = `/tmp/keepon-${safe}-${id}.part.`;
    await this.host.spawnPipe(
      makeCompressionCommand(
        codec,
        localPath,
        archive,
        isDirectory,
        opts?.excludes,
      ),
    );
    const chunks = await this.host.splitFile(archive, CHUNK_BYTES, prefix);
    const chunkSizes = chunks.map((chunk) => this.host.fileSize(chunk));
    const remoteChunks = chunks.map(
      (chunk) => `/tmp/keepon-${safe}-${id}.${basename(chunk)}`,
    );
    const limit = pLimit(UPLOAD_CONCURRENCY);
    await Promise.all(
      chunks.map((chunk, index) =>
        limit(
          async (localChunk: string, remoteChunk: string): Promise<void> => {
            await this.sandbox.uploadPath(remoteChunk, localChunk);
          },
          chunk,
          remoteChunks[index]!,
        ),
      ),
    );
    const totalBytes = chunkSizes.reduce((sum, size) => sum + size, 0);
    const remoteArchive = makeArchivePath(safe, id, codec);
    const catInputs = remoteChunks.map(shellQuote).join(" ");
    const cleanup = [remoteArchive, ...remoteChunks].map(shellQuote).join(" ");
    const lowPriority = opts?.lowPriority === true;
    const restore = await this.sandbox.exec(
      [
        "set -e",
        ...(lowPriority ? [LOW_PRIORITY_SETUP] : []),
        `cat ${catInputs} > ${shellQuote(remoteArchive)}`,
        `test "$(wc -c < ${shellQuote(remoteArchive)} | tr -d ' ')" = ${shellQuote(String(totalBytes))}`,
        ...makeExtractionCommands(
          codec,
          remoteArchive,
          sandboxDestDir,
          lowPriority,
        ),
        `rm -f ${cleanup}`,
      ].join("\n"),
    );
    if (restore.exitCode !== 0)
      throw new Error(`Transfer failed for ${label}: ${restore.stderr}`);
  }
}
