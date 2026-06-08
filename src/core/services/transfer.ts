import { tmpdir } from "node:os";
import pLimit from "p-limit";
import { quote } from "shell-quote";
import { basename, dirname, remotePath } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import type { TransferProgress } from "../ports/progress.js";
import { execShell, type Sandbox } from "../ports/provider.js";
import { randomToken } from "../rand.js";

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
  | "splitFile"
  | "tarZstd"
>;

export interface TransferOptions {
  excludes?: string[];
  onProgress?: (p: TransferProgress) => void;
}

const safeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9.-]/g, "-");

const makeArchiveName = (safe: string, id: string): string =>
  `sandhop-${safe}-${id}.tar.zst`;

const makeLocalArchivePath = (safe: string, id: string): string =>
  `${tmpdir()}/${makeArchiveName(safe, id)}`;

const makeRemoteArchivePath = (safe: string, id: string): string =>
  `/tmp/${makeArchiveName(safe, id)}`;

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

const makeExtractionCommands = (
  remoteArchive: string,
  sandboxDestDir: string,
): string[] => {
  const extract = `zstd -d --long=27 -c ${quote([remoteArchive])} | tar -xf - -C ${quote([sandboxDestDir])}`;
  return [
    `zstd -t ${quote([remoteArchive])}`,
    `mkdir -p ${quote([sandboxDestDir])}`,
    `bash -lc ${quote([`set -o pipefail; ${extract}`])}`,
  ];
};

const makeSizeCheckCommand = (
  remoteArchive: string,
  totalBytes: number,
): string =>
  [
    `actual="$(wc -c < ${quote([remoteArchive])} | tr -d ' ')"`,
    `if [ "$actual" != ${quote([String(totalBytes)])} ]; then`,
    `  echo "archive size mismatch for ${quote([remoteArchive])}: expected ${totalBytes} got $actual" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");

const formatTransferFailure = (
  label: string,
  restore: { exitCode: number; stdout: string; stderr: string },
  context: {
    localPath: string;
    sandboxDestPath: string;
    totalBytes: number;
    chunkCount: number;
  },
): string => {
  return [
    `Transfer failed for ${label}`,
    `exit=${restore.exitCode}`,
    `bytes=${context.totalBytes}`,
    `chunks=${context.chunkCount}`,
    `local=${context.localPath}`,
    `remote=${context.sandboxDestPath}`,
    `stderr=${JSON.stringify(restore.stderr)}`,
    `stdout=${JSON.stringify(restore.stdout)}`,
  ].join(": ");
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
    opts: TransferOptions = {},
  ): Promise<void> {
    opts.onProgress?.({
      label,
      phase: "compress",
      bytesDone: 0,
      bytesTotal: 0,
    });
    const safe = safeLabel(label);
    const id = randomToken(12);
    const isDirectory =
      !this.host.exists(localPath) || this.host.isDirectory(localPath);
    const sandboxDestDir = isDirectory
      ? sandboxDestPath
      : dirname(sandboxDestPath);
    const archive = makeLocalArchivePath(safe, id);
    const prefix = `${tmpdir()}/sandhop-${safe}-${id}.part.`;
    let chunks: string[] = [];
    try {
      const source = tarSource(localPath, isDirectory);
      await this.host.tarZstd(
        source.cwd,
        [source.entry],
        archive,
        opts.excludes === undefined ? undefined : { excludes: opts.excludes },
      );
      chunks = await this.host.splitFile(archive, CHUNK_BYTES, prefix);
      const chunkSizes = chunks.map((chunk) => this.host.fileSize(chunk));
      const totalBytes = chunkSizes.reduce((sum, size) => sum + size, 0);
      opts.onProgress?.({
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
              await this.sandbox.uploadPath(
                remotePath(remoteChunk),
                localChunk,
              );
              uploadedBytes += chunkSizes[index]!;
              opts.onProgress?.({
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
      const remoteArchive = makeRemoteArchivePath(safe, id);
      const catInputs = remoteChunks.map((chunk) => quote([chunk])).join(" ");
      const cleanup = [remoteArchive, ...remoteChunks]
        .map((path) => quote([path]))
        .join(" ");
      opts.onProgress?.({
        label,
        phase: "extract",
        bytesDone: totalBytes,
        bytesTotal: totalBytes,
      });
      const restore = await execShell(
        this.sandbox,
        [
          "set -e",
          'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi',
          'SANDHOP_OWNER="$(id -u):$(id -g)"; if [ "${SANDHOP_RUNTIME_USER:-}" != "" ]; then SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"; fi',
          `cat ${catInputs} > ${quote([remoteArchive])}`,
          makeSizeCheckCommand(remoteArchive, totalBytes),
          ...makeExtractionCommands(remoteArchive, sandboxDestDir),
          `$SUDO chown -R "$SANDHOP_OWNER" ${quote([sandboxDestPath])}`,
          `rm -f ${cleanup}`,
        ].join("\n"),
      );
      if (restore.exitCode !== 0)
        throw new Error(
          formatTransferFailure(label, restore, {
            localPath,
            sandboxDestPath,
            totalBytes,
            chunkCount: chunks.length,
          }),
        );
    } finally {
      await Promise.all(
        [archive, ...chunks].map((path) =>
          this.host.remove(path).catch(() => undefined),
        ),
      );
    }
  }
}
