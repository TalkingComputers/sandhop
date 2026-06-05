import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NodeHost } from "../../src/host/node.js";

test("NodeHost copyTree dereferences symlink profile entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandhop-node-host-"));
  const home = join(root, "home");
  const out = join(root, "out");
  const external = join(root, "external.md");
  const link = join(home, ".claude", "CLAUDE.md");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(external, "external instructions");
  symlinkSync(external, link);

  await new NodeHost({}, home).copyTree(home, [".claude/CLAUDE.md"], out, {
    excludes: [],
  });

  const copied = join(out, ".claude", "CLAUDE.md");
  expect(lstatSync(copied).isSymbolicLink()).toBe(false);
  expect(readFileSync(copied, "utf8")).toBe("external instructions");
});
