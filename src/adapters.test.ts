import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  CLAUDE_CODE,
  CODEX,
  detectAgent,
  findLatestSession,
} from "./adapters.js";

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-home-"));
  const cwd = "/work/proj";
  const ccDir = join(home, ".claude", "projects", "-work-proj");
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(join(ccDir, "old.jsonl"), "{}");
  writeFileSync(join(ccDir, "new.jsonl"), "{}");
  utimesSync(join(ccDir, "old.jsonl"), new Date(1000), new Date(1000));
  utimesSync(join(ccDir, "new.jsonl"), new Date(2000), new Date(2000));
  const cxDir = join(home, ".codex", "sessions", "2026", "05", "31");
  mkdirSync(cxDir, { recursive: true });
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { id: "u-1", cwd },
  });
  writeFileSync(
    join(cxDir, "rollout-2026-05-31T00-00-00-u-1.jsonl"),
    meta + "\n",
  );
  return { home, cwd };
};

test("findLatestSession picks newest claude transcript", () => {
  const { home, cwd } = setup();
  const s = findLatestSession(home, cwd, CLAUDE_CODE);
  expect(s?.sessionId).toBe("new");
});

test("findLatestSession finds codex session by recorded cwd", () => {
  const { home, cwd } = setup();
  const s = findLatestSession(home, cwd, CODEX);
  expect(s?.sessionId).toBe("u-1");
});

test("detectAgent returns both when both have sessions", () => {
  const { home, cwd } = setup();
  expect(detectAgent(home, cwd).sort()).toEqual(["claude-code", "codex"]);
});

test("resumeCmd composes cd + resume", () => {
  expect(CLAUDE_CODE.resumeCmd("abc", "/home/user/p")).toBe(
    "cd /home/user/p && claude --resume abc",
  );
  expect(CODEX.resumeCmd("u-1", "/home/user/p")).toBe(
    "cd /home/user/p && codex resume u-1",
  );
});

test("installCmd installs requested CLI versions", () => {
  expect(CLAUDE_CODE.pkg).toBe("@anthropic-ai/claude-code");
  expect(CLAUDE_CODE.installCmd("2.1.160")).toBe(
    "npm i -g @anthropic-ai/claude-code@2.1.160",
  );
  expect(CODEX.pkg).toBe("@openai/codex");
  expect(CODEX.installCmd("0.136.0")).toBe("npm i -g @openai/codex@0.136.0");
});

test("claude preSeed merges onboarding, trust, and api-key approval", () => {
  const home = mkdtempSync(join(tmpdir(), "keepon-claude-home-"));
  const command = CLAUDE_CODE.preSeed("/home/user/proj")[0]!;
  const script = JSON.parse(command.slice("node -e ".length)) as string;

  execFileSync(process.execPath, ["-e", script], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstu",
      HOME: home,
    },
  });

  expect(CLAUDE_CODE.preSeed("/home/user/proj")).toHaveLength(1);
  expect(command).not.toContain("bypassPermissionsModeAccepted");
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({
    hasCompletedOnboarding: true,
    projects: {
      "/home/user/proj": {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    },
    customApiKeyResponses: {
      approved: ["bcdefghijklmnopqrstu"],
      rejected: [],
    },
  });
});

test("codex preSeed writes reviewed config", () => {
  const command = CODEX.preSeed("/home/user/proj")[1]!;
  const config = command
    .replace("cat > $HOME/.codex/config.toml <<'EOF'\n", "")
    .replace("\nEOF", "");

  expect(config).toBe(`approval_policy = "never"
sandbox_mode = "danger-full-access"
cli_auth_credentials_store = "file"

[projects."/home/user/proj"]
trust_level = "trusted"`);
});
