import pLimit from "p-limit";
import type { HostDeps } from "../ports/host.js";
import type { Sandbox } from "../ports/provider.js";

const CHUNK_BYTES = 90 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 8;

type TransferHost = Pick<HostDeps, "fileSize" | "spawnPipe" | "splitFile">;

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const randomId = (): string => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]!).join("");
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const fileName = (path: string): string => path.split("/").pop()!;

const safeLabel = (label: string): string =>
  label.replace(/[^A-Za-z0-9.-]/g, "-");

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
  ): Promise<void> {
    const safe = safeLabel(label);
    const id = randomId();
    const archive = `/tmp/keepon-${safe}-${id}.tar.zst`;
    const prefix = `/tmp/keepon-${safe}-${id}.part.`;
    await this.host.spawnPipe(
      `tar -cf - -C ${shellQuote(localTree)} . | zstd -T0 -8 --long=27 --check -o ${shellQuote(archive)} -f`,
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
    const remoteArchive = `/tmp/keepon-${safe}-${id}.tar.zst`;
    const catInputs = remoteChunks.map(shellQuote).join(" ");
    const cleanup = [remoteArchive, ...remoteChunks].map(shellQuote).join(" ");
    const restore = await this.sandbox.exec(
      [
        "set -e",
        "command -v zstd || sudo apt-get install -y zstd",
        `cat ${catInputs} > ${shellQuote(remoteArchive)}`,
        `test "$(wc -c < ${shellQuote(remoteArchive)} | tr -d ' ')" = ${shellQuote(String(totalBytes))}`,
        `zstd -t ${shellQuote(remoteArchive)}`,
        `mkdir -p ${shellQuote(sandboxDestDir)}`,
        `zstd -d --long=27 -c ${shellQuote(remoteArchive)} | tar -xf - -C ${shellQuote(sandboxDestDir)}`,
        `rm -f ${cleanup}`,
      ].join("\n"),
    );
    if (restore.exitCode !== 0)
      throw new Error(`Transfer failed for ${label}: ${restore.stderr}`);
  }
}
