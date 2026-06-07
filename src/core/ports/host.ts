export interface HostDeps {
  env: Record<string, string | undefined>;
  home: string;
  username: string;
  cpuCount(): number;
  readFile(path: string): string | null;
  readBytes(path: string): Uint8Array;
  openBlob(path: string): Promise<Blob>;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isSymlink(path: string): boolean;
  readlink(path: string): string;
  walk(dir: string): string[];
  fileSize(path: string): number;
  statMtimeMs(path: string): number;
  keychain(service: string, account: string | null): string | null;
  realpath(path: string): string;
  sha256Hex(input: string): string;
  exec(bin: string, args: string[]): string;
  spawnPipe(cmd: string): Promise<void>;
  remove(path: string): Promise<void>;
  splitFile(
    path: string,
    chunkBytes: number,
    outPrefix: string,
  ): Promise<string[]>;
  copyTree(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void>;
  tarGz(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void>;
}
