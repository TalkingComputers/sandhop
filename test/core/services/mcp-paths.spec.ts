import { expect, test } from "vitest";
import { gitRoot, nearestRoot } from "../../../src/core/services/mcp-paths.js";
import { FakeHost } from "../../fakes/host.js";

test("gitRoot returns the git top-level for files", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/repo/src/index.ts": "" },
    execValues: {
      "git -C /home/local/repo/src rev-parse --show-toplevel":
        "/home/local/repo\n",
    },
  });

  expect(gitRoot(host, "/home/local/repo/src/index.ts")).toBe(
    "/home/local/repo",
  );
});

test("nearestRoot falls back to the input directory when git fails", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/work/src/index.ts": "" },
  });

  expect(nearestRoot(host, "/home/local/work/src/index.ts")).toBe(
    "/home/local/work/src",
  );
  expect(nearestRoot(host, "/home/local/work")).toBe("/home/local/work");
});
