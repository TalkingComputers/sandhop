import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  openAsBlob,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { cp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { cpus, userInfo } from "node:os";
import { execa } from "execa";
import * as tar from "tar";
import { dirname } from "../core/paths.js";
import type { HostDeps } from "../core/ports/host.js";

const listFiles = (dir: string): string[] => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...listFiles(path));
    else paths.push(path);
  }
  return paths;
};

const hasExcludedSegment = (path: string, excludes: string[]): boolean => {
  const segments = path.split("/");
  return excludes.some((exclude) => segments.includes(exclude));
};

export class NodeHost implements HostDeps {
  env: Record<string, string | undefined>;
  home: string;
  username = userInfo().username;

  constructor(env: Record<string, string | undefined>, home: string) {
    this.env = env;
    this.home = home;
  }

  readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  readBytes(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path));
  }

  async openBlob(path: string): Promise<Blob> {
    return openAsBlob(path);
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  isDirectory(path: string): boolean {
    return statSync(path).isDirectory();
  }

  isSymlink(path: string): boolean {
    return lstatSync(path).isSymbolicLink();
  }

  readlink(path: string): string {
    return readlinkSync(path);
  }

  walk(dir: string): string[] {
    return listFiles(dir);
  }

  fileSize(path: string): number {
    return statSync(path).size;
  }

  statMtimeMs(path: string): number {
    return statSync(path).mtimeMs;
  }

  keychain(service: string, account: string | null): string | null {
    try {
      if (process.platform === "darwin") {
        const args =
          account === null
            ? ["find-generic-password", "-w", "-s", service]
            : ["find-generic-password", "-w", "-s", service, "-a", account];
        return execFileSync("security", args, { encoding: "utf8" }).trim();
      }
      if (process.platform === "linux") {
        const args =
          account === null
            ? ["lookup", "service", service]
            : ["lookup", "service", service, "account", account];
        return execFileSync("secret-tool", args, { encoding: "utf8" }).trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  cpuCount(): number {
    return cpus().length;
  }

  realpath(path: string): string {
    return realpathSync.native(path);
  }

  sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  exec(bin: string, args: string[]): string {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async splitFile(
    path: string,
    chunkBytes: number,
    outPrefix: string,
  ): Promise<string[]> {
    const size = this.fileSize(path);
    if (size === 0) {
      const chunk = `${outPrefix}000000`;
      await writeFile(chunk, new Uint8Array());
      return [chunk];
    }
    const chunks: string[] = [];
    const file = await open(path, "r");
    try {
      let offset = 0;
      let index = 0;
      while (offset < size) {
        const length = Math.min(chunkBytes, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead !== length)
          throw new Error(`Short read while splitting ${path}`);
        const chunk = `${outPrefix}${String(index).padStart(6, "0")}`;
        await writeFile(chunk, buffer.subarray(0, bytesRead));
        chunks.push(chunk);
        offset += length;
        index += 1;
      }
      return chunks;
    } finally {
      await file.close();
    }
  }

  async copyTree(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void> {
    await rm(outPath, { recursive: true, force: true });
    await mkdir(outPath, { recursive: true });
    for (const entry of entries) {
      const source = `${cwd}/${entry}`;
      const dest = `${outPath}/${entry}`;
      await mkdir(dirname(dest), { recursive: true });
      await cp(source, dest, {
        recursive: true,
        dereference: true,
        filter:
          opts === undefined
            ? undefined
            : (path) => !hasExcludedSegment(path, opts.excludes),
      });
    }
  }

  async tarGz(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void> {
    await tar.create(
      {
        gzip: true,
        file: outPath,
        cwd,
        portable: true,
        filter:
          opts === undefined
            ? undefined
            : (path) => !hasExcludedSegment(path, opts.excludes),
      },
      entries,
    );
  }

  async tarZstd(
    cwd: string,
    entries: string[],
    outPath: string,
    opts?: { excludes: string[] },
  ): Promise<void> {
    const tarPath = `${outPath}.tar`;
    try {
      await tar.create(
        {
          file: tarPath,
          cwd,
          portable: true,
          filter:
            opts === undefined
              ? undefined
              : (path) => !hasExcludedSegment(path, opts.excludes),
        },
        entries,
      );
      await execa(
        "zstd",
        ["-T0", "-8", "--long=27", "--check", "-o", outPath, "-f", tarPath],
        {
          env: { COPYFILE_DISABLE: "1" },
          stdio: "inherit",
        },
      );
    } finally {
      await rm(tarPath, { force: true });
    }
  }
}
