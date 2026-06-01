import { expect, test, vi } from "vitest";
import { E2bSandboxProvider } from "../../src/providers/e2b/index.js";

const e2bMocks = vi.hoisted(() => {
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
  return { filesWrite, commandsRun, sandbox, Sandbox };
});

vi.mock("e2b", () => ({ Sandbox: e2bMocks.Sandbox }));

test("E2bSandboxProvider creates sandboxes, uploads octet-stream bytes, runs commands, exposes HTTPS URLs, and destroys", async () => {
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
  await sandbox.uploadFile("/tmp/a", new Uint8Array([1, 2]));
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
  expect(e2bMocks.commandsRun).toHaveBeenCalledWith("ttyd", {
    background: true,
    timeoutMs: 0,
  });
});
