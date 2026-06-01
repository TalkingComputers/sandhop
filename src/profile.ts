import { access } from "node:fs/promises";
import { join } from "node:path";
import * as tar from "tar";
import type { AgentId } from "./manifest.js";

export const PROFILE_PATHS: Record<AgentId, readonly string[]> = {
  "claude-code": [
    ".env.d",
    ".claude/settings.json",
    ".claude/CLAUDE.md",
    ".claude.json",
    ".claude/commands",
  ],
  codex: [
    ".env.d",
    ".codex/config.toml",
    ".codex/auth.json",
    ".codex/AGENTS.md",
    ".codex/instructions.md",
    ".codex/prompts",
  ],
};

const hasPath = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const profilePaths = (agent: AgentId): string[] => [
  ...PROFILE_PATHS[agent],
];

export const buildProfile = async (opts: {
  agent: AgentId;
  home: string;
  outDir: string;
}): Promise<string | null> => {
  const paths = (
    await Promise.all(
      profilePaths(opts.agent).map(async (path) =>
        (await hasPath(join(opts.home, path))) ? path : null,
      ),
    )
  ).filter((path): path is string => path !== null);
  if (paths.length === 0) return null;
  const profile = join(opts.outDir, "profile.tgz");
  await tar.create({ gzip: true, file: profile, cwd: opts.home }, paths);
  return profile;
};
