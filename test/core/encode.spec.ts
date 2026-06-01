import { expect, test } from "vitest";
import { projectDirName, safeRemoteProj } from "../../src/core/encode.js";

test("projectDirName replaces every non-alphanumeric character", () => {
  expect(projectDirName("/Users/parsa/Desktop/My Project@2026")).toBe(
    "-Users-parsa-Desktop-My-Project-2026",
  );
});

test("safeRemoteProj keeps a safe basename and encoded transcript directory", () => {
  expect(safeRemoteProj("/Users/parsa/Desktop/My Project@2026")).toEqual({
    dir: "/home/user/My-Project-2026",
    enc: "-home-user-My-Project-2026",
  });
});
