import { expect, test } from "vitest";
import { projectDirName } from "../../src/core/encode.js";

test("projectDirName replaces every non-alphanumeric character", () => {
  expect(projectDirName("/Users/parsa/Desktop/My Project@2026")).toBe(
    "-Users-parsa-Desktop-My-Project-2026",
  );
});
