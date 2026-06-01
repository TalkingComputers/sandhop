import { expect, test } from "vitest";
import { FakeProvider } from "../fakes/provider.js";

test("provider conformance: fake sandbox supports path uploads, command results, background spawn, ports, and destroy", async () => {
  const provider = new FakeProvider();
  const sandbox = await provider.create({
    image: "base",
    envs: {},
    timeoutMs: 1,
  });

  await sandbox.uploadPath("/tmp/archive.tgz", "/local/archive.tgz");
  await expect(sandbox.exec("echo ok")).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("KEEPON_RESTORE_OK"),
  });
  await sandbox.spawn("ttyd");
  await expect(sandbox.exposePort(7681)).resolves.toMatchObject({
    url: expect.stringContaining("7681"),
    authGatedByProvider: false,
  });
  await expect(provider.destroy("sbx-1")).resolves.toBe(true);
});
