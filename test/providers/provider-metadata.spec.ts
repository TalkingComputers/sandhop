import { expect, test, vi } from "vitest";
import { FakeHost } from "../fakes/host.js";

test("provider metadata imports without loading provider implementations", async () => {
  vi.resetModules();
  const fail = (): never => {
    throw new Error("provider implementations should load only when used");
  };
  vi.doMock("../../src/providers/e2b/index.js", fail);
  vi.doMock("../../src/providers/modal/index.js", fail);
  vi.doMock("../../src/providers/daytona/index.js", fail);
  vi.doMock("../../src/providers/vercel/index.js", fail);

  const providers = await import("../../src/providers/index.js");

  expect(providers.PROVIDER_INFO.e2b.label).toBe("E2B");
  expect(providers.PROVIDER_INFO.modal.label).toBe("Modal");
  expect(providers.PROVIDER_INFO.daytona.label).toBe("Daytona");
  expect(providers.PROVIDER_INFO.vercel.label).toBe("Vercel Sandbox");
  const host = new FakeHost({ home: "/home/local", env: {} });
  expect(providers.buildProvider("e2b", host).name).toBe("e2b");
  expect(providers.buildProvider("modal", host).name).toBe("modal");
  expect(providers.buildProvider("daytona", host).name).toBe("daytona");
  expect(providers.buildProvider("vercel", host).name).toBe("vercel");
  vi.doUnmock("../../src/providers/e2b/index.js");
  vi.doUnmock("../../src/providers/modal/index.js");
  vi.doUnmock("../../src/providers/daytona/index.js");
  vi.doUnmock("../../src/providers/vercel/index.js");
});
