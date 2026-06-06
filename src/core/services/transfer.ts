import { tmpdir } from "node:os";
import pLimit from "p-limit";
import { basename, dirname } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import type { TransferProgress } from "../ports/progress.js";
import type { Sandbox } from "../ports/provider.js";
import { randomToken } from "../rand.js";
import { LOW_PRIORITY_SETUP, shellQuote } from "../shell.js";

// 16MB: benchmarked fastest on bandwidth-limited links (more parallel chunks
// saturate the upload than a few 90MB ones) and gives finer transfer progress.
const CHUNK_BYTES = 16 * 1024 * 1024;

type TransferHost = Pick<
  HostDeps,
  | "cpuCount"
  | "exists"
  | "fileSize"
  | "isDirectory"
  | "remove"
  | "spawnPipe"
  | "splitFile"
>;

export type TransferCodec = "gzip" | "zstd";

export interface TransferOptions {
  codec: TransferCodec;
  lowPriority?: boolean;
  excludes?: string[];
}

const safeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9.-]/g, "-");

const makeArchiveName = (
  safe: string,
  id: string,
  codec: TransferCodec,
): string => `sandhop-${safe}-${id}.${codec === "gzip" ? "tar.gz" : "tar.zst"}`;

const makeLocalArchivePath = (
  safe: string,
  id: string,
  codec: TransferCodec,
): string => `${tmpdir()}/${makeArchiveName(safe, id, codec)}`;

const makeRemoteArchivePath = (
  safe: string,
  id: string,
  codec: TransferCodec,
): string => `/tmp/${makeArchiveName(safe, id, codec)}`;

const TAR_CREATE_SETUP = [
  "export COPYFILE_DISABLE=1",
  'SANDHOP_TAR_MAC_FLAGS=""',
  'case "$(tar --help 2>/dev/null)" in *--no-mac-metadata*) SANDHOP_TAR_MAC_FLAGS="--no-mac-metadata";; esac',
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
    `${TAR_CREATE_SETUP}; tar $SANDHOP_TAR_MAC_FLAGS${tarExcludeArgs(opts?.excludes)}`,
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
    `${TAR_CREATE_SETUP}; tar $SANDHOP_TAR_MAC_FLAGS${tarExcludeArgs(excludes)}`,
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
    `set -o pipefail; ${makeTarStreamCommand(localPath, isDirectory, excludes)}`,
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
    lowPriority ? `$SANDHOP_LOW_PRIORITY sh -lc ${shellQuote(cmd)}` : cmd;
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
    opts: TransferOptions,
    onProgress?: (p: TransferProgress) => void,
  ): Promise<void> {
    onProgress?.({ label, phase: "compress", bytesDone: 0, bytesTotal: 0 });
    const safe = safeLabel(label);
    const id = randomToken(12);
    const codec = opts.codec;
    const isDirectory =
      !this.host.exists(localPath) || this.host.isDirectory(localPath);
    const sandboxDestDir = isDirectory
      ? sandboxDestPath
      : dirname(sandboxDestPath);
    const archive = makeLocalArchivePath(safe, id, codec);
    const prefix = `${tmpdir()}/sandhop-${safe}-${id}.part.`;
    let chunks: string[] = [];
    try {
      await this.host.spawnPipe(
        makeCompressionCommand(
          codec,
          localPath,
          archive,
          isDirectory,
          opts?.excludes,
        ),
      );
      chunks = await this.host.splitFile(archive, CHUNK_BYTES, prefix);
      const chunkSizes = chunks.map((chunk) => this.host.fileSize(chunk));
      const totalBytes = chunkSizes.reduce((sum, size) => sum + size, 0);
      onProgress?.({
        label,
        phase: "upload",
        bytesDone: 0,
        bytesTotal: totalBytes,
      });
      const remoteChunks = chunks.map((chunk) => `/tmp/${basename(chunk)}`);
      const limit = pLimit(this.host.cpuCount());
      let uploadedBytes = 0;
      await Promise.all(
        chunks.map((chunk, index) =>
          limit(
            async (localChunk: string, remoteChunk: string): Promise<void> => {
              await this.sandbox.uploadPath(remoteChunk, localChunk);
              uploadedBytes += chunkSizes[index]!;
              onProgress?.({
                label,
                phase: "upload",
                bytesDone: uploadedBytes,
                bytesTotal: totalBytes,
              });
            },
            chunk,
            remoteChunks[index]!,
          ),
        ),
      );
      const remoteArchive = makeRemoteArchivePath(safe, id, codec);
      const catInputs = remoteChunks.map(shellQuote).join(" ");
      const cleanup = [remoteArchive, ...remoteChunks]
        .map(shellQuote)
        .join(" ");
      const lowPriority = opts?.lowPriority === true;
      onProgress?.({
        label,
        phase: "extract",
        bytesDone: totalBytes,
        bytesTotal: totalBytes,
      });
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
    } finally {
      await Promise.all(
        [archive, ...chunks].map((path) =>
          this.host.remove(path).catch(() => undefined),
        ),
      );
    }
  }
}
