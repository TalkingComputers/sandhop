import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import * as tar from "tar";
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

  exists(path: string): boolean {
    return existsSync(path);
  }

  isDirectory(path: string): boolean {
    return statSync(path).isDirectory();
  }

  walk(dir: string): string[] {
    return listFiles(dir);
  }

  statMtimeMs(path: string): number {
    return statSync(path).mtimeMs;
  }

  keychain(service: string, account: string | null): string | null {
    try {
      const args =
        account === null
          ? ["find-generic-password", "-w", "-s", service]
          : ["find-generic-password", "-w", "-s", service, "-a", account];
      return execFileSync("security", args, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  }

  realpath(path: string): string {
    return realpathSync.native(path);
  }

  sha256Hex(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  exec(bin: string, args: string[]): string {
    return execFileSync(bin, args, { encoding: "utf8" });
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
        filter:
          opts === undefined
            ? undefined
            : (path) => !hasExcludedSegment(path, opts.excludes),
      },
      entries,
    );
  }
}
