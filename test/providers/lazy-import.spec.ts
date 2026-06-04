import { expect, test } from "vitest";
import { lazyImport } from "../../src/providers/lazy-import.js";

test("lazyImport returns loaded modules", async () => {
  const module = await lazyImport<typeof import("node:buffer")>(
    "node:buffer",
    "install buffer",
  );

  expect(module.Buffer.from("ok").toString()).toBe("ok");
});

test("lazyImport rewrites missing package errors to the install hint", async () => {
  await expect(
    lazyImport("missing-keepon-sdk", "install missing-keepon-sdk"),
  ).rejects.toThrow("install missing-keepon-sdk");
});
