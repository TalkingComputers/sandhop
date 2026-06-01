import { expect, test } from "vitest";
import { TransferService } from "../../../src/core/services/transfer.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

test("TransferService compresses with zstd, chunks locally, uploads chunks, verifies size and integrity, and extracts in one restore exec", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
  );

  expect(host.spawnPipeCalls).toHaveLength(1);
  expect(host.spawnPipeCalls[0]).toContain(
    "tar -cf - -C '/workspace/project' . | zstd -T0 -8 --long=27 --check",
  );
  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: expect.stringMatching(
        /\/tmp\/keepon-bundle-.+\.part\.000000$/,
      ),
      localPath: expect.stringMatching(
        /\/tmp\/keepon-bundle-.+\.part\.000000$/,
      ),
    },
  ]);
  expect(provider.sandbox.execs).toHaveLength(1);
  expect(provider.sandbox.execs[0]).toContain("cat ");
  expect(provider.sandbox.execs[0]).toContain("wc -c");
  expect(provider.sandbox.execs[0]).toContain("zstd -t");
  expect(provider.sandbox.execs[0]).toContain("zstd -d --long=27 -c");
  expect(provider.sandbox.execs[0]).toContain(
    "tar -xf - -C '/home/user/project'",
  );
});
