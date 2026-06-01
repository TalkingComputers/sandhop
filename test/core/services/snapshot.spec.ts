import { expect, test } from "vitest";
import { SnapshotService } from "../../../src/core/services/snapshot.js";
import { FakeHost } from "../../fakes/host.js";

test("SnapshotService tars the cwd byte-exact with no excludes", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  await expect(
    new SnapshotService(host).build("/workspace/project", "/tmp/bundle.tgz"),
  ).resolves.toBe("/tmp/bundle.tgz");

  expect(host.tarCalls).toEqual([
    { cwd: "/workspace/project", entries: ["."], outPath: "/tmp/bundle.tgz" },
  ]);
});
