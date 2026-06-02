import pLimit from "p-limit";
import type { HostDeps } from "../ports/host.js";
import type { Sandbox } from "../ports/provider.js";

const CHUNK_BYTES = 90 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 8;

type TransferHost = Pick<HostDeps, "fileSize" | "spawnPipe" | "splitFile">;

export type TransferCodec = "gzip" | "zstd";

export interface TransferOptions {
  codec: TransferCodec;
  lowPriority?: boolean;
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const randomId = (): string => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]!).join("");
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const LOW_PRIORITY_SETUP =
  'KEEPON_LOW_PRIORITY="nice -n 19"; if command -v ionice >/dev/null 2>&1; then KEEPON_LOW_PRIORITY="nice -n 19 ionice -c3"; fi';

const fileName = (path: string): string => path.split("/").pop()!;

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

export const makeTarGzipCommand = (archive: string, cwd: string): string =>
  `${TAR_CREATE_SETUP}; tar $KEEPON_TAR_MAC_FLAGS -czf ${shellQuote(archive)} -C ${shellQuote(cwd)} .`;

const makeTarStreamCommand = (cwd: string): string =>
  `${TAR_CREATE_SETUP}; tar $KEEPON_TAR_MAC_FLAGS -cf - -C ${shellQuote(cwd)} .`;

const makeCompressionCommand = (
  codec: TransferCodec,
  localTree: string,
  archive: string,
): string => {
  if (codec === "gzip") return makeTarGzipCommand(archive, localTree);
  return [
    makeTarStreamCommand(localTree),
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
    localTree: string,
    sandboxDestDir: string,
    label: string,
    opts?: TransferOptions,
  ): Promise<void> {
    const safe = safeLabel(label);
    const id = randomId();
    const codec = readCodec(opts);
    const archive = makeArchivePath(safe, id, codec);
    const prefix = `/tmp/keepon-${safe}-${id}.part.`;
    await this.host.spawnPipe(
      makeCompressionCommand(codec, localTree, archive),
    );
    const chunks = await this.host.splitFile(archive, CHUNK_BYTES, prefix);
    const chunkSizes = chunks.map((chunk) => this.host.fileSize(chunk));
    const remoteChunks = chunks.map(
      (chunk) => `/tmp/keepon-${safe}-${id}.${fileName(chunk)}`,
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
