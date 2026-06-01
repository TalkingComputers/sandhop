import { expect, test } from "vitest";
import { CLAUDE_CODE } from "./adapters.js";
import { renderBootstrap } from "./bootstrap.js";
import { buildManifest } from "./manifest.js";

const m = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  originalCwd: "/Users/p/proj",
  sessionId: "abc",
  transcriptName: "abc.jsonl",
  ts: 1,
});

test("bootstrap installs exact CLI version, pre-seeds, extracts, and copies transcript byte-exact", () => {
  const s = renderBootstrap(m, CLAUDE_CODE);
  expect(s).toContain(
    "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64",
  );
  expect(s).toContain("npm i -g @anthropic-ai/claude-code@2.1.160");
  expect(s).toContain("hasCompletedOnboarding");
  expect(s).toContain('projects[\\"/home/user/proj\\"]');
  expect(s).toContain("tar -xzf /tmp/bundle.tgz -C /home/user/proj");
  expect(s).toContain("$HOME/.claude/projects/-home-user-proj/abc.jsonl");
  expect(s).not.toContain("sed");
  expect(s).toContain("KEEPON_RESTORE_OK");
});

test("bootstrap starts tailscale userspace networking when enabled", () => {
  const s = renderBootstrap(m, CLAUDE_CODE, {
    tailscale: { sandboxId: "sbx-1" },
  });
  expect(s).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
  expect(s).toContain(
    "sudo tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1055 --statedir=/tmp/tailscaled &",
  );
  expect(s).toContain(
    'sudo tailscale up --authkey="$TS_AUTHKEY" --hostname="keepon-sbx-1" --accept-dns=false',
  );
});
