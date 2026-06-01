import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import * as tar from "tar";
import { buildManifest } from "./manifest.js";
import { buildBundle } from "./snapshot.js";

test("buildBundle tars working tree and includes transcript+manifest", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "keepon-cwd-"));
  writeFileSync(join(cwd, "a.txt"), "hello");
  mkdirSync(join(cwd, "node_modules"));
  writeFileSync(join(cwd, "node_modules", "junk"), "x");
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".git", "config"), "x");
  const tx = join(cwd, "session.jsonl");
  writeFileSync(tx, "{}");
  const out = mkdtempSync(join(tmpdir(), "keepon-out-"));
  const m = buildManifest({
    agent: "claude-code",
    cliVersion: "2.1.160",
    originalCwd: cwd,
    sessionId: "s",
    transcriptName: "s.jsonl",
    ts: 1,
  });

  const res = await buildBundle({
    cwd,
    transcriptPath: tx,
    manifest: m,
    outDir: out,
  });

  expect(existsSync(res.bundle)).toBe(true);
  expect(existsSync(res.transcript)).toBe(true);
  expect(existsSync(res.manifestPath)).toBe(true);
  const names: string[] = [];
  await tar.list({ file: res.bundle, onentry: (e) => names.push(e.path) });
  expect(names.some((n) => n.endsWith("a.txt"))).toBe(true);
  expect(names.some((n) => n.endsWith("node_modules/junk"))).toBe(true);
  expect(names.some((n) => n.endsWith(".git/config"))).toBe(true);
});
