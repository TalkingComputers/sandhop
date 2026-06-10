import { expect, test } from "vitest";
import { CloudflaredTransport } from "../../src/transports/cloudflared.js";
import { FakeSandbox } from "../fakes/provider.js";

const service = {
  port: 7681,
  output: "",
};

test("CloudflaredTransport quick mode returns the trycloudflare URL", async () => {
  const sandbox = new FakeSandbox("sbx-1", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user",
  });
  const transport = new CloudflaredTransport({});

  const result = await transport.expose({
    sandbox,
    service,
  });

  expect(transport.id).toBe("cloudflared");
  expect(transport.bindAddress()).toBe("127.0.0.1");
  expect(transport.bootstrapSteps()).toEqual(["command -v cloudflared"]);
  expect(sandbox.services[0]).toMatchObject({
    file: "cloudflared",
    args: [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      "http://localhost:7681",
    ],
    port: 7681,
    stdoutPath: "/tmp/sandhop-cloudflared.log",
    stderrPath: "/tmp/sandhop-cloudflared.log",
    appendOutput: true,
  });
  expect(sandbox.services[0]!.readiness.kind).toBe("log");
  expect(result).toEqual({ url: "https://quick.example" });
});

test("CloudflaredTransport named mode returns the configured hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user",
  });
  const transport = new CloudflaredTransport({
    token: "cloudflare-token",
    hostname: "sandhop.example.com",
  });

  const result = await transport.expose({
    sandbox,
    service,
  });

  expect(sandbox.services[0]).toMatchObject({
    file: "cloudflared",
    args: [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "run",
      "--token",
      "cloudflare-token",
    ],
  });
  expect(sandbox.services[0]!.readiness.kind).toBe("log");
  expect(result).toEqual({ url: "https://sandhop.example.com" });
});

test("CloudflaredTransport named mode requires a hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1", {
    home: "/home/user",
    username: "user",
    workdir: "/home/user",
  });
  const transport = new CloudflaredTransport({ token: "cloudflare-token" });

  await expect(
    transport.expose({
      sandbox,
      service,
    }),
  ).rejects.toThrow(
    "CLOUDFLARE_TUNNEL_HOSTNAME is required for a named cloudflared tunnel",
  );
});
