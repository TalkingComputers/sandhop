import { expect, test } from "vitest";
import { isRecord } from "../../src/core/json.js";

test("isRecord accepts plain objects and rejects arrays, null, and primitives", () => {
  expect(isRecord({ ok: true })).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord("value")).toBe(false);
});
