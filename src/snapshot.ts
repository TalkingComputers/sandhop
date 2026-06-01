import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import * as tar from "tar";
import type { Manifest } from "./manifest.js";

const walkRel = (root: string, dir: string): string[] => {
  let out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkRel(root, p));
    else out.push(relative(root, p));
  }
  return out;
};

const listFiles = (cwd: string): string[] => {
  if (existsSync(join(cwd, ".git"))) {
    const raw = execFileSync(
      "git",
      [
        "-C",
        cwd,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    return raw.split("\0").filter(Boolean);
  }
  return walkRel(cwd, cwd);
};

export const buildBundle = async (opts: {
  cwd: string;
  transcriptPath: string;
  manifest: Manifest;
  outDir: string;
}): Promise<{ bundle: string; transcript: string; manifestPath: string }> => {
  const bundle = join(opts.outDir, "bundle.tgz");
  const transcript = join(opts.outDir, "transcript.jsonl");
  const manifestPath = join(opts.outDir, "manifest.json");
  await tar.create(
    { gzip: true, file: bundle, cwd: opts.cwd },
    listFiles(opts.cwd),
  );
  copyFileSync(opts.transcriptPath, transcript);
  writeFileSync(manifestPath, JSON.stringify(opts.manifest));
  return { bundle, transcript, manifestPath };
};
