import { expect, test } from "vitest";
import { SnapshotService } from "../../../src/core/services/snapshot.js";
import { FakeHost } from "../../fakes/host.js";

test("SnapshotService returns the byte-exact working tree root", async () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  await expect(
    new SnapshotService(host).build("/workspace/project"),
  ).resolves.toBe("/workspace/project");

  expect(host.tarCalls).toEqual([]);
});
