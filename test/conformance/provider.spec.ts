import { expect, test } from "vitest";
import { remotePath } from "../../src/core/paths.js";
import { FakeProvider } from "../fakes/provider.js";

test("provider conformance: fake sandbox supports path uploads, command results, background spawn, ports, and destroy", async () => {
  const provider = new FakeProvider();
  const sandbox = await provider.create({
    envs: {},
    timeoutMs: 1,
    ports: [7681],
  });

  await sandbox.uploadPath(
    remotePath("/tmp/archive.tgz"),
    "/local/archive.tgz",
  );
  await expect(sandbox.exec("echo", ["ok"])).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining("SANDHOP_RESTORE_OK"),
  });
  await sandbox.spawn("ttyd", []);
  await expect(sandbox.exposePort(7681)).resolves.toMatchObject({
    url: expect.stringContaining("7681"),
  });
  await expect(provider.destroy("sbx-1")).resolves.toBe(true);
});
