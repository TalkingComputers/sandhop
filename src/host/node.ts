import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
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

  walk(dir: string): string[] {
    return listFiles(dir);
  }

  statMtimeMs(path: string): number {
    return statSync(path).mtimeMs;
  }

  keychain(service: string): string | null {
    try {
      return execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", service],
        { encoding: "utf8" },
      ).trim();
    } catch {
      return null;
    }
  }

  exec(bin: string, args: string[]): string {
    return execFileSync(bin, args, { encoding: "utf8" });
  }

  async tarGz(cwd: string, entries: string[], outPath: string): Promise<void> {
    await tar.create({ gzip: true, file: outPath, cwd }, entries);
  }
}
