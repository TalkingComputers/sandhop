import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CLAUDE_CODE } from "./adapters.js";
import { buildManifest } from "./manifest.js";
import { teleport, type SandboxClient } from "./sandbox.js";

const makeFake = () => {
  const calls: string[] = [];
  const client: SandboxClient = {
    create: async (t, envs) => {
      calls.push(`create:${t}:${Object.keys(envs).join(",")}`);
      return "sbx-1";
    },
    writeFile: async (_id, p) => void calls.push(`write:${p}`),
    run: async (_id, cmd, bg) => {
      calls.push(`run:${bg ? "bg" : "fg"}:${cmd.slice(0, 12)}`);
      return bg
        ? undefined
        : { exitCode: 0, stdout: "KEEPON_RESTORE_OK\n", stderr: "" };
    },
    host: async (_id, port) => `sbx-1-${port}.e2b.app`,
  };
  return { client, calls };
};

test("teleport runs the full sequence and returns url", async () => {
  const out = mkdtempSync(join(tmpdir(), "keepon-sb-"));
  const bundle = join(out, "b.tgz");
  const transcript = join(out, "t.jsonl");
  writeFileSync(bundle, "x");
  writeFileSync(transcript, "{}");
  const manifest = buildManifest({
    agent: "claude-code",
    originalCwd: "/Users/p/proj",
    sessionId: "abc",
    transcriptName: "abc.jsonl",
    ts: 1,
  });
  const { client, calls } = makeFake();

  const res = await teleport(client, {
    bundle,
    transcript,
    manifest,
    adapter: CLAUDE_CODE,
    auth: { envs: { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, files: [] },
    timeoutMs: 3_600_000,
  });

  expect(res.url).toBe("https://sbx-1-7681.e2b.app");
  expect(calls[0]).toBe("create:keepon-ttyd:ANTHROPIC_API_KEY");
  expect(calls).toContain("write:/tmp/bundle.tgz");
  expect(calls.some((c) => c.startsWith("run:fg"))).toBe(true);
  expect(calls.some((c) => c.startsWith("run:bg"))).toBe(true);
});

test("teleport throws when restore marker missing", async () => {
  const out = mkdtempSync(join(tmpdir(), "keepon-sb2-"));
  writeFileSync(join(out, "b.tgz"), "x");
  writeFileSync(join(out, "t.jsonl"), "{}");
  const manifest = buildManifest({
    agent: "claude-code",
    originalCwd: "/p",
    sessionId: "a",
    transcriptName: "a.jsonl",
    ts: 1,
  });
  const client: SandboxClient = {
    create: async () => "id",
    writeFile: async () => {},
    run: async (_i, _c, bg) =>
      bg ? undefined : { exitCode: 1, stdout: "", stderr: "boom" },
    host: async () => "h",
  };
  await expect(
    teleport(client, {
      bundle: join(out, "b.tgz"),
      transcript: join(out, "t.jsonl"),
      manifest,
      adapter: CLAUDE_CODE,
      auth: { envs: { ANTHROPIC_API_KEY: "sk-ant-x" }, files: [] },
      timeoutMs: 1,
    }),
  ).rejects.toThrow(/boom/);
});
