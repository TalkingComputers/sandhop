import { expect, test } from "vitest";
import { projectDirName, safeRemoteProj } from "../../src/core/encode.js";

test("projectDirName replaces every non-alphanumeric character", () => {
  expect(projectDirName("/Users/parsa/Desktop/My Project@2026")).toBe(
    "-Users-parsa-Desktop-My-Project-2026",
  );
});

test("safeRemoteProj mirrors the original cwd and encodes the transcript directory", () => {
  expect(safeRemoteProj("/Users/alice/proj")).toEqual({
    dir: "/Users/alice/proj",
    enc: "-Users-alice-proj",
  });
});
