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
  vi.spyOn(console, "log").mockImplementation((): void => undefined);
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

  expect(host.spawnDetachedCalls[0]!.args.slice(1)).toEqual([
    "--sandbox-id",
    "sbx-1",
    "--agent",
    "codex",
    "--cwd",
    "/workspace/project",
    "--provider",
    "e2b",
    "--exclude",
    "node_modules",
    "--exclude",
    "dist",
    "--exclude",
    ".cache",
  ]);
});
