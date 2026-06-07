import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { TransferService } from "../../../src/core/services/transfer.js";
import { FakeHost } from "../../fakes/host.js";
import { FakeProvider } from "../../fakes/provider.js";

test("TransferService emits compression, upload, and extraction progress", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();
  const events: {
    label: string;
    phase: string;
    bytesDone: number;
    bytesTotal: number;
  }[] = [];

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
    {
      onProgress: (event: {
        label: string;
        phase: string;
        bytesDone: number;
        bytesTotal: number;
      }): void => {
        events.push(event);
      },
    },
  );

  expect(events).toEqual([
    { label: "bundle", phase: "compress", bytesDone: 0, bytesTotal: 0 },
    { label: "bundle", phase: "upload", bytesDone: 0, bytesTotal: 7 },
    { label: "bundle", phase: "upload", bytesDone: 7, bytesTotal: 7 },
    { label: "bundle", phase: "extract", bytesDone: 7, bytesTotal: 7 },
  ]);
});

test("TransferService chunks zstd archives, verifies size and integrity, and extracts in one restore exec", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/project",
    "/home/user/project",
    "bundle",
  );

  expect(host.spawnPipeCalls).toHaveLength(1);
  expect(host.spawnPipeCalls[0]).toContain("set -o pipefail; ");
  expect(host.spawnPipeCalls[0]).toContain("-cf - -C '/workspace/project' .");
  expect(host.spawnPipeCalls[0]).toContain("| zstd -T0 -8 --long=27 --check");
  expect(provider.sandbox.pathUploads).toEqual([
    {
      remotePath: expect.stringMatching(
        /\/tmp\/sandhop-bundle-.+\.part\.000000$/,
      ),
      localPath: expect.stringMatching(
        new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.part\\.000000$`),
      ),
    },
  ]);
  expect(provider.sandbox.execs).toHaveLength(1);
  expect(provider.sandbox.execs[0]).toContain("cat ");
  expect(provider.sandbox.execs[0]).toContain("wc -c");
  expect(provider.sandbox.execs[0]).toContain("zstd -t");
  expect(provider.sandbox.execs[0]).toContain("zstd -d --long=27 -c");
  expect(provider.sandbox.execs[0]).toContain("tar -xf - -C ");
  expect(provider.sandbox.execs[0]).toContain(
    'SANDHOP_OWNER="$(id -u):$(id -g)"; if [ "${SANDHOP_RUNTIME_USER:-}" != "" ]; then SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"; fi',
  );
  expect(provider.sandbox.execs[0]).toContain(
    "$SUDO chown -R \"$SANDHOP_OWNER\" '/home/user/project'",
  );
  expect(provider.sandbox.execs[0]).toContain("/home/user/project");
  expect(provider.sandbox.execs[0]).not.toContain("apt-get");
  expect(host.removedPaths[0]).toMatch(
    new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.tar\\.zst$`),
  );
  expect(host.removedPaths[1]).toMatch(
    new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.part\\.000000$`),
  );
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

test("TransferService runs zstd extraction with pipefail", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();

  await new TransferService(host, provider.sandbox).send(
    "/workspace/profile",
    "/home/user",
    "profile",
  );

  expect(provider.sandbox.execs[0]).toContain(
    "bash -lc 'set -o pipefail; zstd -d --long=27 -c",
  );
  expect(provider.sandbox.execs[0]).toContain(" | tar -xf - -C ");
});

test("TransferService deletes host archives and chunks after sandbox extract failure", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });
  const provider = new FakeProvider();
  provider.sandbox.execResults.push({
    exitCode: 1,
    stdout: "",
    stderr: "extract failed",
  });

  await expect(
    new TransferService(host, provider.sandbox).send(
      "/workspace/project",
      "/home/user/project",
      "bundle",
    ),
  ).rejects.toThrow(
    'Transfer failed for bundle: exit=1: bytes=7: chunks=1: local=/workspace/project: remote=/home/user/project: stderr="extract failed": stdout=""',
  );

  expect(host.removedPaths[0]).toMatch(
    new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.tar\\.zst$`),
  );
  expect(host.removedPaths[1]).toMatch(
    new RegExp(`${tmpdir()}/sandhop-bundle-.+\\.part\\.000000$`),
  );
});
