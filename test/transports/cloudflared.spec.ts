import { expect, test } from "vitest";
import { CloudflaredTransport } from "../../src/transports/cloudflared.js";
import { FakeSandbox } from "../fakes/provider.js";

test("CloudflaredTransport quick mode returns the trycloudflare URL", async () => {
  const sandbox = new FakeSandbox("sbx-1");
  sandbox.execResults.push({
    exitCode: 0,
    stdout: "https://fresh-pond.trycloudflare.com\n",
    stderr: "",
  });
  const transport = new CloudflaredTransport({});

  const result = await transport.expose({
    sandbox,
    localPort: 7681,
    user: "keepon",
    pass: "pass",
  });

  expect(transport.id).toBe("cloudflared");
  expect(transport.ttydBindAddress()).toBe("127.0.0.1");
  expect(transport.bootstrapSteps()).toContain(
    "sudo curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared",
  );
  expect(sandbox.spawns).toEqual([
    "cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:7681 > /tmp/keepon-cloudflared.log 2>&1",
  ]);
  expect(sandbox.execs[0]).toBe(
    `bash -lc 'for i in $(seq 1 120); do u=$(grep -oE "https://[a-z0-9-]+\\.trycloudflare\\.com" /tmp/keepon-cloudflared.log | head -1); [ -n "$u" ] && grep -q "Registered tunnel connection" /tmp/keepon-cloudflared.log && { echo "$u"; exit 0; }; sleep 0.5; done; cat /tmp/keepon-cloudflared.log >&2; exit 1'`,
  );
  expect(result).toEqual({ url: "https://fresh-pond.trycloudflare.com" });
});

test("CloudflaredTransport named mode returns the configured hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1");
  sandbox.execResults.push({ exitCode: 0, stdout: "", stderr: "" });
  const transport = new CloudflaredTransport({
    token: "cloudflare-token",
    hostname: "keepon.example.com",
  });

  const result = await transport.expose({
    sandbox,
    localPort: 7681,
    user: "keepon",
    pass: "pass",
  });

  expect(sandbox.spawns).toEqual([
    "cloudflared tunnel --no-autoupdate --protocol http2 run --token 'cloudflare-token' > /tmp/keepon-cloudflared.log 2>&1",
  ]);
  expect(sandbox.execs[0]).toContain("Registered tunnel connection");
  expect(result).toEqual({ url: "https://keepon.example.com" });
});

test("CloudflaredTransport named mode requires a hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1");
  const transport = new CloudflaredTransport({ token: "cloudflare-token" });

  await expect(
    transport.expose({
      sandbox,
      localPort: 7681,
      user: "keepon",
      pass: "pass",
    }),
  ).rejects.toThrow(
    "CLOUDFLARE_TUNNEL_HOSTNAME is required for a named cloudflared tunnel",
  );
});
