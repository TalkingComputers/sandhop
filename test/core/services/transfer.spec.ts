import { expect, test } from "vitest";
import { TransferService } from "../../../src/core/services/transfer.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

test("TransferService defaults to gzip, chunks locally, uploads chunks, verifies size and integrity, and extracts in one restore exec", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
  );

  expect(host.spawnPipeCalls).toHaveLength(1);
  expect(host.spawnPipeCalls[0]).toContain("-czf '/tmp/keepon-bundle-");
  expect(host.spawnPipeCalls[0]).toContain("-C '/workspace/project' .");
  expect(host.spawnPipeCalls[0]).not.toContain("zstd");
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
  expect(provider.sandbox.execs[0]).toContain("gzip -t");
  expect(provider.sandbox.execs[0]).toContain("tar -xzf '/tmp/keepon-bundle-");
  expect(provider.sandbox.execs[0]).not.toContain("zstd");
  expect(provider.sandbox.execs[0]).not.toContain("apt-get");
  expect(provider.sandbox.execs[0]).not.toContain("sudo");
});

test("TransferService disables macOS AppleDouble metadata while creating archives", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
  );

  expect(host.spawnPipeCalls[0]).toContain("COPYFILE_DISABLE=1");
  expect(host.spawnPipeCalls[0]).toContain("--no-mac-metadata");
});

test("TransferService zstd codec keeps multithreaded zstd compression and zstd integrity checks", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
    { codec: "zstd" },
  );

  expect(host.spawnPipeCalls).toHaveLength(1);
  expect(host.spawnPipeCalls[0]).toContain("-cf - -C '/workspace/project' .");
  expect(host.spawnPipeCalls[0]).toContain("| zstd -T0 -8 --long=27 --check");
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
  expect(provider.sandbox.execs[0]).not.toContain("apt-get");
});

test("TransferService can run sandbox extraction under low CPU and IO priority", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/profile",
    "/home/user",
    "profile",
    { codec: "zstd", lowPriority: true },
  );

  expect(provider.sandbox.execs[0]).toContain(
    'KEEPON_LOW_PRIORITY="nice -n 19"',
  );
  expect(provider.sandbox.execs[0]).toContain("nice -n 19 ionice -c3");
  expect(provider.sandbox.execs[0]).toContain(
    "$KEEPON_LOW_PRIORITY sh -lc 'zstd -d --long=27 -c",
  );
  expect(provider.sandbox.execs[0]).toContain(" | tar -xf - -C ");
});
