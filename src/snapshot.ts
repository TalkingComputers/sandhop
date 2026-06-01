import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import type { Manifest } from "./manifest.js";

export const buildBundle = async (opts: {
  cwd: string;
  transcriptPath: string;
  manifest: Manifest;
  outDir: string;
}): Promise<{ bundle: string; transcript: string; manifestPath: string }> => {
  const bundle = join(opts.outDir, "bundle.tgz");
  const transcript = join(opts.outDir, "transcript.jsonl");
  const manifestPath = join(opts.outDir, "manifest.json");
  await tar.create({ gzip: true, file: bundle, cwd: opts.cwd }, ["."]);
  copyFileSync(opts.transcriptPath, transcript);
  writeFileSync(manifestPath, JSON.stringify(opts.manifest));
  return { bundle, transcript, manifestPath };
};
