import { expect, test } from "vitest";
import type { ProviderId } from "../../src/providers/index.js";
import { PROVIDER_IDS, buildProvider } from "../../src/providers/index.js";
import { FakeHost } from "../fakes/host.js";

test("provider registry lists e2b, modal, and daytona", () => {
  expect(PROVIDER_IDS).toEqual(["e2b", "modal", "daytona"]);
});

test("provider registry builds all supported providers", () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect(buildProvider("e2b", host).name).toBe("e2b");
  expect(buildProvider("modal", host).name).toBe("modal");
  expect(buildProvider("daytona", host).name).toBe("daytona");
});

test("provider registry rejects unknown providers", () => {
  const host = new FakeHost({ home: "/home/local", env: {} });

  expect(() => buildProvider("bogus" as ProviderId, host)).toThrow(
    "Unknown provider bogus",
  );
});
