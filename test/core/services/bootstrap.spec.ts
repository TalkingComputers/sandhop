import { expect, test } from "vitest";
import { CLAUDE_CODE } from "../../../src/agents/claude-code.js";
import { BootstrapService } from "../../../src/core/services/bootstrap.js";
import { buildManifest } from "../../../src/core/manifest.js";

const manifest = buildManifest({
  agent: "claude-code",
  cliVersion: "2.1.160",
  originalCwd: "/workspace/project",
  sessionId: "session-id",
  transcriptName: "session-id.jsonl",
  ts: 1,
});

test("BootstrapService installs exact CLI version, restores tar and transcript, and never sources local secret dirs", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
    hasProfile: true,
  });

  expect(script).toContain("npm i -g @anthropic-ai/claude-code@2.1.160");
  expect(script).toContain("tar -xzf /tmp/bundle.tgz -C /home/user/project");
  expect(script).toContain('cp /tmp/transcript.jsonl "$dest"');
  expect(script).toContain("tar -xzf /tmp/profile.tgz -C $HOME");
  expect(script).toContain("KEEPON_RESTORE_OK");
  expect(script).not.toContain("for f in");
});

test("BootstrapService enables tailscale binary mode when requested", () => {
  const script = new BootstrapService(CLAUDE_CODE).render(manifest, {
    hasProfile: false,
    tailscale: { sandboxId: "sbx-1" },
  });

  expect(script).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
  expect(script).toContain('--hostname="keepon-sbx-1"');
});
