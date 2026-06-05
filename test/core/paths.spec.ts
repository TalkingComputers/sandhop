import { expect, test } from "vitest";
import {
  dirname,
  expandHome,
  listSkillNames,
  makeTempPath,
  normalizePath,
} from "../../src/core/paths.js";
import { FakeHost } from "../fakes/host.js";

test("dirname handles paths without slash and absolute parents", () => {
  expect(dirname("settings.json")).toBe(".");
  expect(dirname("dir/settings.json")).toBe("dir");
  expect(dirname("/tmp/settings.json")).toBe("/tmp");
  expect(dirname("/tmp/dir/")).toBe("/tmp");
  expect(dirname("/")).toBe("/");
});

test("home path functions expand provided homes", () => {
  expect(expandHome("$HOME/.codex/auth.json", "/Users/parsa")).toBe(
    "/Users/parsa/.codex/auth.json",
  );
  expect(expandHome("~/.codex/auth.json", "/Users/parsa")).toBe(
    "/Users/parsa/.codex/auth.json",
  );
  expect(expandHome("$HOME/.codex/auth.json", "/home/user")).toBe(
    "/home/user/.codex/auth.json",
  );
  expect(makeTempPath("profile")).toMatch(/^\/tmp\/sandhop-\d+-profile$/);
});

test("normalizePath collapses POSIX dot segments", () => {
  expect(normalizePath("/tmp/./a/../b")).toBe("/tmp/b");
  expect(normalizePath("tmp/./a/../b")).toBe("tmp/b");
});

test("listSkillNames returns sorted first-level skill directories", () => {
  const host = new FakeHost({
    home: "/home/local",
    env: {},
    files: {
      "/home/local/.claude/skills/zeta/SKILL.md": "zeta",
      "/home/local/.claude/skills/alpha/SKILL.md": "alpha",
      "/home/local/.claude/skills/alpha/docs/readme.md": "docs",
    },
  });

  expect(listSkillNames(host, "/home/local/.claude/skills")).toEqual([
    "alpha",
    "zeta",
  ]);
  expect(listSkillNames(host, "/home/local/.claude/missing")).toEqual([]);
});
