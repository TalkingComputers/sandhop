import { tmpdir } from "node:os";
import pLimit from "p-limit";
import { quote } from "shell-quote";
import { basename, dirname, remotePath } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import type { TransferProgress } from "../ports/progress.js";
import { execShell, type Sandbox } from "../ports/provider.js";
import { randomToken } from "../rand.js";
import {
  renderChownToRuntimeUser,
  renderCreateOwnedDirs,
} from "../sandbox-scripts.js";

// 16MB: benchmarked fastest on bandwidth-limited links (more parallel chunks
// saturate the upload than a few 90MB ones) and gives finer transfer progress.
const CHUNK_BYTES = 16 * 1024 * 1024;
const CHUNK_UPLOAD_DEADLINE_MS = 900_000;
const EXTRACT_DEADLINE_MS = 900_000;

// Provider SDK promises can dangle (lost socket without rejection), draining
// the event loop and killing the process silently. The pending timer both
// keeps the loop alive and converts a dangle into a visible failure.
const withDeadline = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((unused, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

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
  onSkipped?: (paths: string[]) => void;
}

const safeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9.-]/g, "-");

const makeArchiveName = (safe: string, id: string): string =>
  `sandhop-${safe}-${id}.tar.zst`;

const makeLocalArchivePath = (safe: string, id: string): string =>
  `${tmpdir()}/${makeArchiveName(safe, id)}`;

const makeRemoteArchivePath = (safe: string, id: string): string =>
  `/tmp/${makeArchiveName(safe, id)}`;

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
    ...renderCreateOwnedDirs([sandboxDestDir]),
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
    if (!this.host.exists(localPath))
      throw new Error(`Transfer source missing for ${label}: ${localPath}`);
    const safe = safeLabel(label);
    const id = randomToken(12);
    const isDirectory = this.host.isDirectory(localPath);
    const sandboxDestDir = isDirectory
      ? sandboxDestPath
      : dirname(sandboxDestPath);
    const archive = makeLocalArchivePath(safe, id);
    const prefix = `${tmpdir()}/sandhop-${safe}-${id}.part.`;
    let chunks: string[] = [];
    try {
      const source = tarSource(localPath, isDirectory);
      const tarResult = await this.host.tarZstd(
        source.cwd,
        [source.entry],
        archive,
        opts.excludes === undefined ? undefined : { excludes: opts.excludes },
      );
      if (tarResult.skippedPaths.length > 0)
        opts.onSkipped?.(tarResult.skippedPaths);
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
              await withDeadline(
                this.sandbox.uploadPath(remotePath(remoteChunk), localChunk),
                CHUNK_UPLOAD_DEADLINE_MS,
                `Chunk upload ${remoteChunk} (${label})`,
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
      const restore = await withDeadline(
        execShell(
          this.sandbox,
          [
            "set -e",
            `cat ${catInputs} > ${quote([remoteArchive])}`,
            makeSizeCheckCommand(remoteArchive, totalBytes),
            ...makeExtractionCommands(remoteArchive, sandboxDestDir),
            ...renderChownToRuntimeUser([sandboxDestPath], true),
            `rm -f ${cleanup}`,
          ].join("\n"),
        ),
        EXTRACT_DEADLINE_MS,
        `Archive extraction (${label})`,
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
        [archive, ...chunks].map((path) => this.host.remove(path)),
      );
    }
  }
}
