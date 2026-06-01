export interface HostDeps {
  env: Record<string, string | undefined>;
  home: string;
  readFile(path: string): string | null;
  readBytes(path: string): Uint8Array;
  exists(path: string): boolean;
  walk(dir: string): string[];
  statMtimeMs(path: string): number;
  keychain(service: string): string | null;
  exec(bin: string, args: string[]): string;
  tarGz(cwd: string, entries: string[], outPath: string): Promise<void>;
}
