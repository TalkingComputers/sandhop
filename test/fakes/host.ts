import type { HostDeps } from "../../src/core/ports/host.js";

const encoder = new TextEncoder();

export class FakeHost implements HostDeps {
  env: Record<string, string | undefined>;
  home: string;
  files: Record<string, string>;
  bytes: Record<string, Uint8Array>;
  mtimes: Record<string, number>;
  keychainValues: Record<string, string>;
  execValues: Record<string, string>;
  tarCalls: { cwd: string; entries: string[]; outPath: string }[];
  execCalls: { bin: string; args: string[] }[];

  constructor(args: {
    home: string;
    env: Record<string, string | undefined>;
    files?: Record<string, string>;
    bytes?: Record<string, Uint8Array>;
    mtimes?: Record<string, number>;
    keychainValues?: Record<string, string>;
    execValues?: Record<string, string>;
  }) {
    this.home = args.home;
    this.env = args.env;
    this.files = args.files ?? {};
    this.bytes = args.bytes ?? {};
    this.mtimes = args.mtimes ?? {};
    this.keychainValues = args.keychainValues ?? {};
    this.execValues = args.execValues ?? {};
    this.tarCalls = [];
    this.execCalls = [];
  }

  readFile(path: string): string | null {
    return Object.hasOwn(this.files, path) ? this.files[path]! : null;
  }

  readBytes(path: string): Uint8Array {
    if (Object.hasOwn(this.bytes, path)) return this.bytes[path]!;
    if (Object.hasOwn(this.files, path))
      return encoder.encode(this.files[path]!);
    throw new Error(`missing bytes ${path}`);
  }

  exists(path: string): boolean {
    const prefix = `${path}/`;
    return (
      Object.hasOwn(this.files, path) ||
      Object.hasOwn(this.bytes, path) ||
      Object.keys(this.files).some((filePath) => filePath.startsWith(prefix)) ||
      Object.keys(this.bytes).some((filePath) => filePath.startsWith(prefix))
    );
  }

  walk(dir: string): string[] {
    const prefix = `${dir}/`;
    return [...Object.keys(this.files), ...Object.keys(this.bytes)]
      .filter((path) => path.startsWith(prefix))
      .sort();
  }

  statMtimeMs(path: string): number {
    if (Object.hasOwn(this.mtimes, path)) return this.mtimes[path]!;
    throw new Error(`missing mtime ${path}`);
  }

  keychain(service: string): string | null {
    return Object.hasOwn(this.keychainValues, service)
      ? this.keychainValues[service]!
      : null;
  }

  exec(bin: string, args: string[]): string {
    this.execCalls.push({ bin, args });
    const key = [bin, ...args].join(" ");
    if (Object.hasOwn(this.execValues, key)) return this.execValues[key]!;
    throw new Error(`missing exec ${key}`);
  }

  async tarGz(cwd: string, entries: string[], outPath: string): Promise<void> {
    this.tarCalls.push({ cwd, entries, outPath });
    this.bytes[outPath] = encoder.encode(`tar:${cwd}:${entries.join(",")}`);
  }
}
