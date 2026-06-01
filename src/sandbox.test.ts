import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { CLAUDE_CODE, CODEX } from "./adapters.js";
import { buildManifest } from "./manifest.js";
import { e2bClient, teleport, type SandboxClient } from "./sandbox.js";

const e2bMocks = vi.hoisted(() => {
  const filesWrite = vi.fn();
  const commandsRun = vi.fn();
  const sandbox = {
    files: { write: filesWrite },
    commands: { run: commandsRun },
    getHost: vi.fn(),
  };
  const Sandbox = {
    create: vi.fn(),
    connect: vi.fn(),
    list: vi.fn(),
    kill: vi.fn(),
  };
  return { filesWrite, commandsRun, sandbox, Sandbox };
});

vi.mock("e2b", () => ({ Sandbox: e2bMocks.Sandbox }));

beforeEach(() => {
  e2bMocks.filesWrite.mockReset();
  e2bMocks.commandsRun.mockReset();
  e2bMocks.sandbox.getHost.mockReset();
  e2bMocks.Sandbox.create.mockReset();
  e2bMocks.Sandbox.connect.mockReset();
  e2bMocks.Sandbox.list.mockReset();
  e2bMocks.Sandbox.kill.mockReset();
  e2bMocks.Sandbox.connect.mockResolvedValue(e2bMocks.sandbox);
});

const makeFake = () => {
  const calls: string[] = [];
  const writes: { path: string; data: unknown }[] = [];
  const client: SandboxClient = {
    create: async (t, envs) => {
      calls.push(`create:${t}:${Object.keys(envs).join(",")}`);
      return "sbx-1";
    },
    writeFile: async (_id, p, data) => {
      calls.push(`write:${p}`);
      writes.push({ path: p, data });
    },
    run: async (_id, cmd, bg) => {
      calls.push(`run:${bg ? "bg" : "fg"}:${cmd.slice(0, 12)}`);
      return bg
        ? undefined
        : { exitCode: 0, stdout: "KEEPON_RESTORE_OK\n", stderr: "" };
    },
    host: async (_id, port) => `sbx-1-${port}.e2b.app`,
  };
  return { client, calls, writes };
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
  const { client, calls, writes } = makeFake();

  const res = await teleport(client, {
    bundle,
    transcript,
    manifest,
    adapter: CLAUDE_CODE,
    auth: { envs: { ANTHROPIC_API_KEY: "sk-ant-api03-x" }, files: [] },
    timeoutMs: 3_600_000,
  });

  expect(res.url).toBe("https://sbx-1-7681.e2b.app");
  expect(calls[0]).toBe("create:base:ANTHROPIC_API_KEY");
  expect(calls).toContain("write:/tmp/bundle.tgz");
  expect(writes[0]).toMatchObject({ path: "/tmp/bundle.tgz" });
  expect(writes[0]!.data).toBeInstanceOf(Uint8Array);
  expect([...(writes[0]!.data as Uint8Array).values()]).toEqual([120]);
  expect(writes[1]).toMatchObject({ path: "/tmp/transcript.jsonl" });
  expect(writes[1]!.data).toBeInstanceOf(Uint8Array);
  expect([...(writes[1]!.data as Uint8Array).values()]).toEqual([123, 125]);
  expect(calls.some((c) => c.startsWith("run:fg"))).toBe(true);
  expect(calls.some((c) => c.startsWith("run:bg"))).toBe(true);
});

test("teleport expands auth file HOME before upload", async () => {
  const out = mkdtempSync(join(tmpdir(), "keepon-sb-auth-"));
  const bundle = join(out, "b.tgz");
  const transcript = join(out, "t.jsonl");
  writeFileSync(bundle, "x");
  writeFileSync(transcript, "{}");
  const manifest = buildManifest({
    agent: "codex",
    originalCwd: "/Users/p/proj",
    sessionId: "u-1",
    transcriptName: "rollout-2026-05-31T00-00-00-u-1.jsonl",
    ts: 1,
  });
  const { client, calls } = makeFake();

  await teleport(client, {
    bundle,
    transcript,
    manifest,
    adapter: CODEX,
    auth: {
      envs: {},
      files: [{ path: "$HOME/.codex/auth.json", content: "{}" }],
    },
    timeoutMs: 3_600_000,
  });

  expect(calls).toContain("write:/home/user/.codex/auth.json");
  expect(calls).not.toContain("write:$HOME/.codex/auth.json");
});

test("e2bClient writes buffered bodies with upload timeout", async () => {
  await e2bClient.writeFile("sbx-1", "/tmp/bundle.tgz", new Uint8Array([1, 2]));

  const call = e2bMocks.filesWrite.mock.calls[0]!;
  expect(call[0]).toBe("/tmp/bundle.tgz");
  expect(new Uint8Array(call[1] as ArrayBuffer)).toEqual(
    new Uint8Array([1, 2]),
  );
  expect(call[2]).toEqual({
    requestTimeoutMs: 600000,
    useOctetStream: true,
  });
});

test("e2bClient gives foreground commands bootstrap timeouts", async () => {
  e2bMocks.commandsRun.mockResolvedValue({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });

  await expect(e2bClient.run("sbx-1", "bootstrap", false)).resolves.toEqual({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("bootstrap", {
    timeoutMs: 600000,
    requestTimeoutMs: 600000,
  });
});

test("e2bClient keeps ttyd commands in the background without timeout", async () => {
  await e2bClient.run("sbx-1", "ttyd", true);

  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("ttyd", {
    background: true,
    timeoutMs: 0,
  });
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
