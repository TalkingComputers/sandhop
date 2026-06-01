import { join } from "node:path";
import type { AgentId } from "./manifest.js";

export interface AuthDeps {
  env: Record<string, string | undefined>;
  keychain(service: string): string | null;
  readFile(path: string): string | null;
  home: string;
}

export interface AuthBundle {
  envs: Record<string, string>;
  files: { path: string; content: string }[];
}

export const extractAuth = (agent: AgentId, deps: AuthDeps): AuthBundle => {
  if (agent === "claude-code") {
    const apiKey =
      deps.env.ANTHROPIC_API_KEY ?? deps.keychain("Claude Code") ?? "";
    if (apiKey.startsWith("sk-ant-"))
      return { envs: { ANTHROPIC_API_KEY: apiKey }, files: [] };
    const oauth = deps.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauth) return { envs: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, files: [] };
    throw new Error(
      "No Claude Code credential. Run: claude setup-token, then export CLAUDE_CODE_OAUTH_TOKEN",
    );
  }
  const authJson = deps.readFile(join(deps.home, ".codex", "auth.json"));
  const envs: Record<string, string> = {};
  if (deps.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = deps.env.OPENAI_API_KEY;
  if (authJson)
    return {
      envs,
      files: [{ path: "$HOME/.codex/auth.json", content: authJson }],
    };
  if (Object.keys(envs).length) return { envs, files: [] };
  throw new Error(
    "No Codex credential at ~/.codex/auth.json and no OPENAI_API_KEY",
  );
};
