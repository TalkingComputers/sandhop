import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { buildHost } from "../../src/cli/host.js";
import { withRuntimeDefaults } from "../../src/cli/main.js";
import {
  EnrichmentStepId,
  PushProgressId,
  type EnrichmentProgressListener,
} from "../../src/core/ports/progress.js";
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

test("main keeps progress reporting behind reporter methods", () => {
  const source = readFileSync("src/cli/main.ts", "utf8");

  expect(source).not.toContain("bar!");
  expect(source).not.toContain("enrichmentBar!");
  expect(source).not.toContain("as EnrichmentProgressBar");
  expect(source).not.toContain("const ENRICHMENT_STEPS = 7");
  expect(source).not.toContain("hasFailedStep");
  expect(source).not.toContain(["str", "ict"].join(""));
});

test("main streams non-TTY progress to stdout before printing push output", async () => {
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
  const provider = {
    connect: vi.fn(async () => ({ id: "sbx-1", home: "/home/user" })),
  };
  vi.doMock("../../src/providers/index.js", () => ({
    PROVIDER_IDS: ["e2b", "modal", "daytona", "vercel"],
    resolveCredentials: () => ({}),
    buildProvider: () => provider,
  }));
  const sandbox = { id: "sbx-1", home: "/home/user" };
  const order: string[] = [];
  const runEnrichment = vi.fn(
    async (
      argsValue: unknown,
      hostValue: unknown,
      sandboxValue: unknown,
      onEvent: EnrichmentProgressListener,
    ) => {
      order.push("enrich");
      onEvent({
        kind: "enrichStep",
        step: EnrichmentStepId.Setup,
        status: "ok",
      });
      return {
        steps: [{ step: EnrichmentStepId.Setup, ok: true }],
        mcpExcluded: [],
      };
    },
  );
  vi.doMock("../../src/cli/enrich.js", () => ({
    runEnrichment,
  }));
  vi.doMock("../../src/core/services/teleport.js", () => ({
    TeleportService: class {
      async run(
        cwd: string,
        opts: {
          onProgress?: (event: { step: PushProgressId }) => void;
          beforeTerminalStart?: (sandbox: typeof sandbox) => Promise<void>;
        },
      ): Promise<{
        url: string;
        sandboxId: string;
        user: string;
        pass: string;
        sandbox: typeof sandbox;
        sshHosts: string[];
      }> {
        opts.onProgress?.({ step: PushProgressId.Snapshotting });
        order.push("before-terminal");
        await opts.beforeTerminalStart?.(sandbox);
        order.push("terminal");
        return {
          url: "https://sandbox.example",
          sandboxId: "sbx-1",
          user: "user",
          pass: "pass",
          sandbox,
          sshHosts: [],
        };
      }
    },
  }));
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((): void => undefined);
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((): void => undefined);
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: false,
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
      "--exclude",
      "node_modules,dist",
      "--exclude",
      ".cache",
    ]),
  ).rejects.toThrow("exit 0");

  expect(log.mock.calls.map((call) => call[0])).toEqual([
    "Snapshotting session",
    "Preparing",
    "SANDHOP_URL https://sandbox.example",
    "SANDHOP_AUTH user:pass",
  ]);
  expect(error).not.toHaveBeenCalled();
  expect(order).toEqual(["before-terminal", "enrich", "terminal"]);
  expect(provider.connect).not.toHaveBeenCalled();
  expect(runEnrichment).toHaveBeenCalledWith(
    {
      agent: "codex",
      cwd: "/workspace/project",
      excludes: ["node_modules", "dist", ".cache"],
      profile: true,
    },
    host,
    sandbox,
    expect.any(Function),
  );
});

test("main shows inline enrichment progress in TTY push", async () => {
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
  const bars: {
    start: ReturnType<typeof vi.fn>;
    advance: ReturnType<typeof vi.fn>;
    message: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
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
        error: vi.fn(),
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
    resolveCredentials: () => ({}),
    buildProvider: () => ({
      connect: vi.fn(async () => ({ id: "sbx-tail", home: "/home/user" })),
    }),
  }));
  const sandbox = { id: "sbx-tail", home: "/home/user" };
  vi.doMock("../../src/cli/enrich.js", () => ({
    runEnrichment: vi.fn(
      async (
        argsValue: unknown,
        hostValue: unknown,
        sandboxValue: unknown,
        onEvent: EnrichmentProgressListener,
      ) => {
        onEvent({
          kind: "enrichStep",
          step: EnrichmentStepId.Setup,
          status: "start",
        });
        onEvent({
          kind: "enrichStep",
          step: EnrichmentStepId.Setup,
          status: "ok",
        });
        return {
          steps: [{ step: EnrichmentStepId.Setup, ok: true }],
          mcpExcluded: [],
        };
      },
    ),
  }));
  vi.doMock("../../src/core/services/teleport.js", () => ({
    TeleportService: class {
      async run(
        cwd: string,
        opts: {
          beforeTerminalStart?: (sandbox: typeof sandbox) => Promise<void>;
        },
      ): Promise<{
        url: string;
        sandboxId: string;
        user: string;
        pass: string;
        sandbox: typeof sandbox;
        sshHosts: string[];
      }> {
        await opts.beforeTerminalStart?.(sandbox);
        return {
          url: "https://sandbox.example",
          sandboxId: "sbx-tail",
          user: "user",
          pass: "pass",
          sandbox,
          sshHosts: [],
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

  expect(bars[1]!.start).toHaveBeenCalledWith(
    "Syncing profile, MCP servers & skills…",
  );
  expect(bars[1]!.advance).toHaveBeenCalledWith(1, "Preparing");
  expect(bars[1]!.stop).toHaveBeenCalledWith(
    "Environment ready · 1/1 steps ok",
  );
});
