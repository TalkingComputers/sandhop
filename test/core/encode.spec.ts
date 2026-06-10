import { expect, test } from "vitest";
import { projectDirName } from "../../src/core/encode.js";

test("projectDirName replaces every non-alphanumeric character", () => {
  expect(projectDirName("/Users/alice/Desktop/My Project@2026")).toBe(
    "-Users-alice-Desktop-My-Project-2026",
  );
});
