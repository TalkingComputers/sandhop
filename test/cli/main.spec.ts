import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { buildHost } from "../../src/cli/host.js";
import { withRuntimeDefaults } from "../../src/cli/main.js";
import { NodeHost } from "../../src/host/node.js";
import { FakeHost } from "../fakes/host.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../src/cli/host.js");
  vi.doUnmock("../../src/providers/index.js");
  vi.doUnmock("../../src/core/services/teleport.js");
  vi.resetModules();
});

test("withRuntimeDefaults leaves transport unresolved for list and kill", () => {
  const home = "/tmp/sandhop-test-no-config";

  expect(
    withRuntimeDefaults(
      parseArgs(["list", "--provider", "e2b"], "/workspace/project"),
      new NodeHost({}, home),
    ),
  ).toMatchObject({ cmd: "list", provider: "e2b", transport: undefined });
  expect(
    withRuntimeDefaults(
      parseArgs(["kill", "sbx-1", "--provider", "modal"], "/workspace/project"),
      new NodeHost({}, home),
    ),
  ).toMatchObject({ cmd: "kill", provider: "modal", transport: undefined });
});

test("buildHost fails fast on native Windows", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  expect(() => buildHost()).toThrow(
    "sandhop requires a POSIX environment (macOS/Linux). On Windows, run it under WSL.",
  );
});

test("buildHost uses os.homedir instead of HOME", () => {
  const originalHome = process.env["HOME"];
  process.env["HOME"] = "/tmp/not-the-real-home";

  try {
    expect(buildHost().home).toBe(homedir());
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  }
});

test("main forwards excludes to detached enrichment", async () => {
  const transcript =
    "/home/local/.codex/sessions/2026/06/05/rollout-2026-06-05T00-00-00-session.jsonl";
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [transcript]: '{"payload":{"cwd":"/workspace/project"}}\n',
    },
    mtimes: {
      [transcript]: 1,
    },
  });

  vi.doMock("../../src/cli/host.js", () => ({
    buildHost: () => host,
  }));
  vi.doMock("../../src/providers/index.js", () => ({
    PROVIDER_IDS: ["e2b", "modal", "daytona", "vercel"],
    buildProvider: () => ({}),
  }));
  vi.doMock("../../src/core/services/teleport.js", () => ({
    TeleportService: class {
      async run(): Promise<{
        url: string;
        sandboxId: string;
        user: string;
        pass: string;
      }> {
        return {
          url: "https://sandbox.example",
          sandboxId: "sbx-1",
          user: "user",
          pass: "pass",
        };
      }
    },
  }));
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((): void => undefined);
  vi.spyOn(console, "error").mockImplementation((): void => undefined);
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null | undefined): never => {
      throw new Error(`exit ${String(code)}`);
    },
  );

  const { main } = await import("../../src/cli/main.js");

  await expect(
    main([
      "push",
      "--agent",
      "codex",
      "--cwd",
      "/workspace/project",
      "--provider",
      "e2b",
      "--tunnel",
      "public",
      "--exclude",
      "node_modules,dist",
      "--exclude",
      ".cache",
    ]),
  ).rejects.toThrow("exit 0");

  expect(log.mock.calls.map((call) => call[0])).toEqual([
    "SANDHOP_URL https://sandbox.example",
    "SANDHOP_AUTH user:pass",
    "SANDHOP_ENRICHING sbx-1",
    "enrichment running in background (profile, skills, MCP servers)",
  ]);
  expect(host.spawnDetachedCalls[0]!.opts.cwd).toBe("/workspace/project");
  expect(Object.hasOwn(host.spawnDetachedCalls[0]!.opts, "stdoutPath")).toBe(
    false,
  );
  expect(host.spawnDetachedCalls[0]!.args.slice(1)).toEqual([
    "--sandbox-id",
    "sbx-1",
    "--agent",
    "codex",
    "--cwd",
    "/workspace/project",
    "--provider",
    "e2b",
    "--progress-file",
    "/tmp/sandhop-progress-sbx-1.jsonl",
    "--exclude",
    "node_modules",
    "--exclude",
    "dist",
    "--exclude",
    ".cache",
  ]);
});

test("main tails foreground enrichment progress in TTY push", async () => {
  const progressPath = "/tmp/sandhop-progress-sbx-tail.jsonl";
  if (existsSync(progressPath)) unlinkSync(progressPath);
  const transcript =
    "/home/local/.codex/sessions/2026/06/05/rollout-2026-06-05T00-00-00-session.jsonl";
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      [transcript]: '{"payload":{"cwd":"/workspace/project"}}\n',
    },
    mtimes: {
      [transcript]: 1,
    },
  });
  host.spawnDetached = (
    bin: string,
    args: string[],
    opts: {
      cwd: string;
      env: Record<string, string | undefined>;
    },
  ): void => {
    host.spawnDetachedCalls.push({ bin, args, opts });
    const progressFileIndex = args.indexOf("--progress-file");
    expect(progressFileIndex).toBeGreaterThan(-1);
    expect(args[progressFileIndex + 1]).toBe(progressPath);
    writeFileSync(
      args[progressFileIndex + 1]!,
      [
        "/*stdin*\\ : 26.11%   (  1.00 MiB =>   267 KiB, /tmp/archive.zst)",
        '{"kind":"enrichStep","name":"enrichment setup","status":"start"}',
        '{"kind":"enrichStep","name":"enrichment setup","status":"ok"}',
        '{"kind":"done","okSteps":1,"totalSteps":7}',
        "",
      ].join("\n"),
    );
  };
  const bars: {
    start: ReturnType<typeof vi.fn>;
    advance: ReturnType<typeof vi.fn>;
    message: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];

  vi.doMock("@clack/prompts", () => ({
    intro: vi.fn(),
    note: vi.fn(),
    outro: vi.fn(),
    progress: vi.fn(() => {
      const bar = {
        start: vi.fn(),
        advance: vi.fn(),
        message: vi.fn(),
        stop: vi.fn(),
      };
      bars.push(bar);
      return bar;
    }),
  }));
  vi.doMock("../../src/cli/host.js", () => ({
    buildHost: () => host,
  }));
  vi.doMock("../../src/providers/index.js", () => ({
    PROVIDER_IDS: ["e2b", "modal", "daytona", "vercel"],
    buildProvider: () => ({}),
  }));
  vi.doMock("../../src/core/services/teleport.js", () => ({
    TeleportService: class {
      async run(): Promise<{
        url: string;
        sandboxId: string;
        user: string;
        pass: string;
      }> {
        return {
          url: "https://sandbox.example",
          sandboxId: "sbx-tail",
          user: "user",
          pass: "pass",
        };
      }
    },
  }));
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null | undefined): never => {
      throw new Error(`exit ${String(code)}`);
    },
  );

  const { main } = await import("../../src/cli/main.js");

  await expect(
    main([
      "push",
      "--agent",
      "codex",
      "--cwd",
      "/workspace/project",
      "--provider",
      "e2b",
      "--tunnel",
      "public",
    ]),
  ).rejects.toThrow("exit 0");

  expect(bars[1]!.start).toHaveBeenCalledWith("Setting up your environment…");
  expect(bars[1]!.advance).toHaveBeenCalledWith(1, "Preparing");
  expect(bars[1]!.stop).toHaveBeenCalledWith("Environment ready · 1/7");
  if (existsSync(progressPath)) unlinkSync(progressPath);
});
