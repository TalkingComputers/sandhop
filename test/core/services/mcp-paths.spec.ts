import { expect, test } from "vitest";
import { gitRoot, projectRoot } from "../../../src/core/services/mcp-paths.js";
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

test("projectRoot fails when git root is unavailable", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: { "/home/local/work/src/index.ts": "" },
  });

  expect(() => projectRoot(host, "/home/local/work/src/index.ts")).toThrow(
    "Git root not found for MCP path: /home/local/work/src/index.ts",
  );
});
