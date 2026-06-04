import { expect, test } from "vitest";
import {
  dirname,
  expandHome,
  makeTempPath,
  normalizePath,
  sandboxExpandHome,
} from "../../src/core/paths.js";

test("dirname handles paths without slash and absolute parents", () => {
  expect(dirname("settings.json")).toBe(".");
  expect(dirname("dir/settings.json")).toBe("dir");
  expect(dirname("/tmp/settings.json")).toBe("/tmp");
  expect(dirname("/tmp/dir/")).toBe("/tmp");
  expect(dirname("/")).toBe("/");
});

test("home path functions expand host and sandbox homes", () => {
  expect(expandHome("$HOME/.codex/auth.json", "/Users/parsa")).toBe(
    "/Users/parsa/.codex/auth.json",
  );
  expect(expandHome("~/.codex/auth.json", "/Users/parsa")).toBe(
    "/Users/parsa/.codex/auth.json",
  );
  expect(sandboxExpandHome("$HOME/.codex/auth.json")).toBe(
    "/home/user/.codex/auth.json",
  );
  expect(makeTempPath("profile")).toMatch(/^\/tmp\/keepon-\d+-profile$/);
});

test("normalizePath collapses POSIX dot segments", () => {
  expect(normalizePath("/tmp/./a/../b")).toBe("/tmp/b");
  expect(normalizePath("tmp/./a/../b")).toBe("tmp/b");
});
