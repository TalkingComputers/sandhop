import { expect, test } from "vitest";
import { PublicTransport } from "../../src/transports/public.js";
import { FakeSandbox } from "../fakes/provider.js";

test("PublicTransport exposes the provider port", async () => {
  const sandbox = new FakeSandbox("sbx-1", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user",
  });
  const transport = new PublicTransport();

  const result = await transport.expose({
    sandbox,
    localPort: 7681,
  });

  expect(transport.id).toBe("public");
  expect(transport.ttydBindAddress()).toBe("0.0.0.0");
  expect(transport.bootstrapSteps()).toEqual([]);
  expect(sandbox.exposedPorts).toEqual([7681]);
  expect(result).toEqual({ url: "https://sandbox-sbx-1-7681.example" });
});
