import { expect, test } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { withRuntimeDefaults } from "../../src/cli/main.js";
import { NodeHost } from "../../src/host/node.js";

test("withRuntimeDefaults leaves transport unresolved for list and kill", () => {
  const home = "/tmp/sandhop-test-no-config";

  expect(
    withRuntimeDefaults(
      parseArgs(["list", "--provider", "e2b"], "/workspace/project"),
      new NodeHost({}, home),
    ),
  ).toMatchObject({ cmd: "list", provider: "e2b", transport: undefined });
  expect(
    withRuntimeDefaults(
      parseArgs(["kill", "sbx-1", "--provider", "modal"], "/workspace/project"),
      new NodeHost({}, home),
    ),
  ).toMatchObject({ cmd: "kill", provider: "modal", transport: undefined });
});
