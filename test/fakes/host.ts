import type { HostDeps } from "../../src/core/ports/host.js";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export class FakeHost implements HostDeps {
  env: Record<string, string | undefined>;
  home: string;
  username = "host-user";
  files: Record<string, string>;
  bytes: Record<string, Uint8Array>;
  symlinks: Record<string, string>;
  mtimes: Record<string, number>;
  keychainValues: Record<string, string>;
  execValues: Record<string, string>;
  tarCalls: {
    cwd: string;
    entries: string[];
    outPath: string;
    excludes?: string[];
  }[];
  copyCalls: {
    cwd: string;
    entries: string[];
    outPath: string;
    excludes?: string[];
  }[];
  execCalls: { bin: string; args: string[] }[];
  spawnPipeCalls: string[];
  removedPaths: string[];
  zstdAvailable: boolean;
  spawnDetachedCalls: {
    bin: string;
    args: string[];
    opts: { cwd: string; env: Record<string, string | undefined> };
  }[];

  constructor(args: {
    home: string;
    env: Record<string, string | undefined>;
    files?: Record<string, string>;
    bytes?: Record<string, Uint8Array>;
    symlinks?: Record<string, string>;
    mtimes?: Record<string, number>;
    keychainValues?: Record<string, string>;
    execValues?: Record<string, string>;
    zstdAvailable?: boolean;
  }) {
    this.home = args.home;
    this.env = args.env;
    this.files = args.files ?? {};
    this.bytes = args.bytes ?? {};
    this.symlinks = args.symlinks ?? {};
    this.mtimes = args.mtimes ?? {};
    this.keychainValues = args.keychainValues ?? {};
    this.execValues = args.execValues ?? {};
    this.tarCalls = [];
    this.copyCalls = [];
    this.execCalls = [];
    this.spawnPipeCalls = [];
    this.removedPaths = [];
    this.zstdAvailable = args.zstdAvailable ?? true;
    this.spawnDetachedCalls = [];
  }

  linkedPath(path: string): string {
    if (!Object.hasOwn(this.symlinks, path)) return path;
    const target = this.symlinks[path]!;
    if (target.startsWith("/")) return target;
    const dir = path.slice(0, path.lastIndexOf("/"));
    return `${dir}/${target}`
      .split("/")
      .reduce<string[]>((parts, part) => {
        if (part === "" && parts.length === 0) return [""];
        if (part === "" || part === ".") return parts;
        if (part === "..") {
          parts.pop();
          return parts;
        }
        parts.push(part);
        return parts;
      }, [])
      .join("/");
  }

  readFile(path: string): string | null {
    const linked = this.linkedPath(path);
    return Object.hasOwn(this.files, linked) ? this.files[linked]! : null;
  }

  readBytes(path: string): Uint8Array {
    const linked = this.linkedPath(path);
    if (Object.hasOwn(this.bytes, linked)) return this.bytes[linked]!;
    if (Object.hasOwn(this.files, linked))
      return encoder.encode(this.files[linked]!);
    throw new Error(`missing bytes ${path}`);
  }

  async openBlob(path: string): Promise<Blob> {
    return new Blob([this.readBytes(path)]);
  }

  exists(path: string): boolean {
    const linked = this.linkedPath(path);
    const prefix = `${linked}/`;
    return (
      Object.hasOwn(this.files, linked) ||
      Object.hasOwn(this.bytes, linked) ||
      Object.hasOwn(this.symlinks, path) ||
      Object.keys(this.files).some((filePath) => filePath.startsWith(prefix)) ||
      Object.keys(this.bytes).some((filePath) => filePath.startsWith(prefix)) ||
      Object.keys(this.symlinks).some((filePath) => filePath.startsWith(prefix))
    );
  }

  isDirectory(path: string): boolean {
    const linked = this.linkedPath(path);
    const prefix = `${linked}/`;
    return (
      Object.keys(this.files).some((filePath) => filePath.startsWith(prefix)) ||
      Object.keys(this.bytes).some((filePath) => filePath.startsWith(prefix)) ||
      Object.keys(this.symlinks).some((filePath) => filePath.startsWith(prefix))
    );
  }

  isSymlink(path: string): boolean {
    return Object.hasOwn(this.symlinks, path);
  }

  readlink(path: string): string {
    if (Object.hasOwn(this.symlinks, path)) return this.symlinks[path]!;
    throw new Error(`missing symlink ${path}`);
  }

  walk(dir: string): string[] {
    const prefix = `${dir}/`;
    return [
      ...Object.keys(this.files),
      ...Object.keys(this.bytes),
      ...Object.keys(this.symlinks),
    ]
      .filter((path) => path.startsWith(prefix))
      .sort();
  }

  fileSize(path: string): number {
    return this.readBytes(path).byteLength;
  }

  statMtimeMs(path: string): number {
    if (Object.hasOwn(this.mtimes, path)) return this.mtimes[path]!;
    throw new Error(`missing mtime ${path}`);
  }

  keychain(service: string, account: string | null): string | null {
    const key = account === null ? service : `${service}:${account}`;
    return Object.hasOwn(this.keychainValues, key)
      ? this.keychainValues[key]!
      : null;
  }

  realpath(path: string): string {
    return path;
  }

  cpuCount(): number {
    return 4;
  }

  hasZstd(): boolean {
    return this.zstdAvailable;
  }

  sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  exec(bin: string, args: string[]): string {
    this.execCalls.push({ bin, args });
    const key = [bin, ...args].join(" ");
    if (Object.hasOwn(this.execValues, key)) return this.execValues[key]!;
    throw new Error(`missing exec ${key}`);
  }

  async spawnPipe(cmd: string): Promise<void> {
    this.spawnPipeCalls.push(cmd);
    const zstdArchive = cmd.match(/ -o '([^']+)' -f/)?.[1];
    if (zstdArchive !== undefined)
      this.bytes[zstdArchive] = encoder.encode("archive");
    const gzipArchive = cmd.match(/ -czf '([^']+)' /)?.[1];
    if (gzipArchive !== undefined)
      this.bytes[gzipArchive] = encoder.encode("archive");
  }

  async remove(path: string): Promise<void> {
    this.removedPaths.push(path);
    delete this.files[path];
    delete this.bytes[path];
  }

  spawnDetached(
    bin: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ): void {
    this.spawnDetachedCalls.push({ bin, args, opts });
  }

  async splitFile(
    path: string,
    chunkBytes: number,
    outPrefix: string,
  ): Promise<string[]> {
    const bytes = this.readBytes(path);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const chunk = `${outPrefix}${String(chunks.length).padStart(6, "0")}`;
      this.bytes[chunk] = bytes.slice(offset, offset + chunkBytes);
      chunks.push(chunk);
    }
    if (chunks.length === 0) {
      const chunk = `${outPrefix}000000`;
      this.bytes[chunk] = new Uint8Array();
      chunks.push(chunk);
    }
    return chunks;
  }

  async copyTree(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void> {
    const call =
      opts === undefined
        ? { cwd, entries, outPath }
        : { cwd, entries, outPath, excludes: opts.excludes };
    this.copyCalls.push(call);
    for (const entry of entries) {
      const prefix = `${cwd}/${entry}`;
      for (const [path, content] of Object.entries(this.files)) {
        if (path === prefix || path.startsWith(`${prefix}/`))
          this.files[`${outPath}/${path.slice(cwd.length + 1)}`] = content;
      }
      for (const [path, content] of Object.entries(this.bytes)) {
        if (path === prefix || path.startsWith(`${prefix}/`))
          this.bytes[`${outPath}/${path.slice(cwd.length + 1)}`] = content;
      }
    }
  }

  async tarGz(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void> {
    const call =
      opts === undefined
        ? { cwd, entries, outPath }
        : { cwd, entries, outPath, excludes: opts.excludes };
    this.tarCalls.push(call);
    this.bytes[outPath] = encoder.encode(`tar:${cwd}:${entries.join(",")}`);
  }
}
