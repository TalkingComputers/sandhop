import { expect, test } from "vitest";
import { CloudflaredTransport } from "../../src/transports/cloudflared.js";
import { FakeSandbox } from "../fakes/provider.js";

test("CloudflaredTransport quick mode returns the trycloudflare URL", async () => {
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  sandbox.execResults.push({
    exitCode: 0,
    stdout: "https://fresh-pond.trycloudflare.com\n",
    stderr: "",
  });
  const transport = new CloudflaredTransport({});

  const result = await transport.expose({
    sandbox,
    localPort: 7681,
  });

  expect(transport.id).toBe("cloudflared");
  expect(transport.ttydBindAddress()).toBe("127.0.0.1");
  expect(transport.bootstrapSteps()).toContain(
    "$SUDO curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH} -o /usr/local/bin/cloudflared",
  );
  expect(sandbox.spawns).toEqual([
    'cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:7681 {"stdoutPath":"/tmp/sandhop-cloudflared.log","stderrPath":"/tmp/sandhop-cloudflared.log"}',
  ]);
  expect(sandbox.execs[0]).toBe(
    `for i in $(seq 1 120); do u=$(grep -oE "https://[a-z0-9-]+\\.trycloudflare\\.com" /tmp/sandhop-cloudflared.log | head -1); [ -n "$u" ] && grep -q "Registered tunnel connection" /tmp/sandhop-cloudflared.log && { echo "$u"; exit 0; }; sleep 0.5; done; cat /tmp/sandhop-cloudflared.log >&2; exit 1`,
  );
  expect(result).toEqual({ url: "https://fresh-pond.trycloudflare.com" });
});

test("CloudflaredTransport named mode returns the configured hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  sandbox.execResults.push({ exitCode: 0, stdout: "", stderr: "" });
  const transport = new CloudflaredTransport({
    token: "cloudflare-token",
    hostname: "sandhop.example.com",
  });

  const result = await transport.expose({
    sandbox,
    localPort: 7681,
  });

  expect(sandbox.spawns).toEqual([
    'cloudflared tunnel --no-autoupdate --protocol http2 run --token cloudflare-token {"stdoutPath":"/tmp/sandhop-cloudflared.log","stderrPath":"/tmp/sandhop-cloudflared.log"}',
  ]);
  expect(sandbox.execs[0]).toContain("Registered tunnel connection");
  expect(result).toEqual({ url: "https://sandhop.example.com" });
});

test("CloudflaredTransport named mode requires a hostname", async () => {
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  const transport = new CloudflaredTransport({ token: "cloudflare-token" });

  await expect(
    transport.expose({
      sandbox,
      localPort: 7681,
    }),
  ).rejects.toThrow(
    "CLOUDFLARE_TUNNEL_HOSTNAME is required for a named cloudflared tunnel",
  );
});

test("CloudflaredTransport surfaces stdout when stderr is empty", async () => {
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  sandbox.execResults.push({
    exitCode: 1,
    stdout: "stdout failure",
    stderr: "",
  });
  const transport = new CloudflaredTransport({});

  await expect(
    transport.expose({
      sandbox,
      localPort: 7681,
    }),
  ).rejects.toThrow("stdout failure");
});

test("CloudflaredTransport uses friendly fallback when no output exists", async () => {
  const sandbox = new FakeSandbox("sbx-1", "/home/user");
  sandbox.execResults.push({ exitCode: 1, stdout: "", stderr: "" });
  const transport = new CloudflaredTransport({});

  await expect(
    transport.expose({
      sandbox,
      localPort: 7681,
    }),
  ).rejects.toThrow("cloudflared failed to expose port");
});
