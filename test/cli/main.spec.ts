import { homedir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { buildHost } from "../../src/cli/host.js";
import { withRuntimeDefaults } from "../../src/cli/main.js";
import { NodeHost } from "../../src/host/node.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

test("buildHost fails fast on native Windows", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");

  expect(() => buildHost()).toThrow(
    "sandhop requires a POSIX environment (macOS/Linux). On Windows, run it under WSL.",
  );
});

test("buildHost uses os.homedir instead of HOME", () => {
  const originalHome = process.env["HOME"];
  process.env["HOME"] = "/tmp/not-the-real-home";

  try {
    expect(buildHost().home).toBe(homedir());
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  }
});
