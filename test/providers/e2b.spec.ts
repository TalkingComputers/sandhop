import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { E2bSandboxProvider } from "../../src/providers/e2b/index.js";

const e2bMocks = vi.hoisted(() => {
  class CommandExitError extends Error {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;

    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super(`Command exited with code ${result.exitCode}`);
      this.name = "CommandExitError";
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  }
  const filesWrite = vi.fn();
  const commandsRun = vi.fn();
  const sandbox = {
    sandboxId: "sbx-created",
    files: { write: filesWrite },
    commands: { run: commandsRun },
    getHost: vi.fn((port: number) => `sbx-created-${port}.e2b.app`),
  };
  const Sandbox = {
    create: vi.fn(async () => sandbox),
    connect: vi.fn(async () => sandbox),
    list: vi.fn(),
    kill: vi.fn(async (id: string) => id === "sbx-created"),
  };
  return { CommandExitError, filesWrite, commandsRun, sandbox, Sandbox };
});

vi.mock("e2b", () => ({
  CommandExitError: e2bMocks.CommandExitError,
  Sandbox: e2bMocks.Sandbox,
}));

test("E2bSandboxProvider creates sandboxes, uploads octet-stream bytes and paths, runs commands, exposes HTTPS URLs, and destroys", async () => {
  e2bMocks.commandsRun.mockResolvedValue({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  const provider = new E2bSandboxProvider();

  const sandbox = await provider.create({
    image: "base",
    envs: { A: "1" },
    timeoutMs: 600000,
  });
  const localPath = join(tmpdir(), `keepon-e2b-${Date.now()}.txt`);
  writeFileSync(localPath, "large");
  await sandbox.uploadFile("/tmp/a", new Uint8Array([1, 2]));
  await sandbox.uploadPath("/tmp/large", localPath);
  await expect(sandbox.exec("echo ok")).resolves.toEqual({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });
  await sandbox.spawn("ttyd");
  await expect(sandbox.exposePort(7681)).resolves.toEqual({
    url: "https://sbx-created-7681.e2b.app",
    authGatedByProvider: false,
  });
  await expect(provider.destroy("sbx-created")).resolves.toBe(true);

  expect(e2bMocks.Sandbox.create).toHaveBeenCalledWith("base", {
    envs: { A: "1" },
    timeoutMs: 600000,
  });
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/a",
    new Uint8Array([1, 2]).buffer,
    {
      requestTimeoutMs: 600000,
      useOctetStream: true,
    },
  );
  expect(e2bMocks.filesWrite).toHaveBeenCalledWith(
    "/tmp/large",
    expect.any(Blob),
    {
      requestTimeoutMs: 3_600_000,
      useOctetStream: true,
    },
  );
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("ttyd", {
    background: true,
    timeoutMs: 0,
  });
});

test("E2bSandboxProvider returns non-zero command exits as RunResult data", async () => {
  e2bMocks.commandsRun.mockRejectedValue(
    new e2bMocks.CommandExitError({
      exitCode: 42,
      stdout: "partial",
      stderr: "boom",
    }),
  );
  const provider = new E2bSandboxProvider();
  const sandbox = await provider.create({
    image: "base",
    envs: {},
    timeoutMs: 600000,
  });

  await expect(sandbox.exec("false")).resolves.toEqual({
    exitCode: 42,
    stdout: "partial",
    stderr: "boom",
  });
});
