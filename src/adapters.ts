import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { projectDirName } from "./encode.js";
import type { AgentId } from "./manifest.js";

export interface SessionRef {
  sessionId: string;
  transcriptPath: string;
}

export interface Adapter {
  id: AgentId;
  installCmd: string;
  resumeCmd(sessionId: string, remoteProj: string): string;
  remoteTranscriptPath(remoteEnc: string, transcriptName: string): string;
  preSeed(): string[];
  findSessions(home: string, cwd: string): SessionRef[];
}

const walk = (dir: string): string[] => {
  let out: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else out.push(p);
  }
  return out;
};

const newest = (refs: SessionRef[]): SessionRef[] =>
  [...refs].sort(
    (a, b) =>
      statSync(b.transcriptPath).mtimeMs - statSync(a.transcriptPath).mtimeMs,
  );

export const CLAUDE_CODE: Adapter = {
  id: "claude-code",
  installCmd: "npm i -g @anthropic-ai/claude-code",
  resumeCmd: (id, proj) => `cd ${proj} && claude --resume ${id}`,
  remoteTranscriptPath: (enc, name) => `$HOME/.claude/projects/${enc}/${name}`,
  preSeed: () => [
    "mkdir -p $HOME/.claude",
    `node -e 'const f=process.env.HOME+"/.claude.json";const fs=require("fs");const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j.hasCompletedOnboarding=true;j.bypassPermissionsModeAccepted=true;fs.writeFileSync(f,JSON.stringify(j))'`,
  ],
  findSessions: (home, cwd) => {
    const dir = join(home, ".claude", "projects", projectDirName(cwd));
    return newest(
      walk(dir)
        .filter((p) => p.endsWith(".jsonl"))
        .map((p) => {
          const file = p.split("/").pop()!;
          return { sessionId: file.replace(/\.jsonl$/, ""), transcriptPath: p };
        }),
    );
  },
};

const codexId = (file: string): string => {
  const m = file.match(
    /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/,
  );
  return m![1]!;
};

export const CODEX: Adapter = {
  id: "codex",
  installCmd: "npm i -g @openai/codex",
  resumeCmd: (id, proj) => `cd ${proj} && codex resume ${id}`,
  remoteTranscriptPath: (_enc, name) =>
    `$HOME/.codex/sessions/restored/${name}`,
  preSeed: () => [
    "mkdir -p $HOME/.codex",
    `printf 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n' > $HOME/.codex/config.toml`,
  ],
  findSessions: (home, cwd) => {
    const root = join(home, ".codex", "sessions");
    const refs = walk(root)
      .filter((p) => /rollout-.*\.jsonl$/.test(p))
      .filter((p) => {
        const first = readFileSync(p, "utf8").split("\n", 1)[0] ?? "";
        try {
          return JSON.parse(first)?.payload?.cwd === cwd;
        } catch {
          return false;
        }
      })
      .map((p) => ({ sessionId: codexId(p), transcriptPath: p }));
    return newest(refs);
  },
};

export const ADAPTERS: Record<AgentId, Adapter> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
};

export const findLatestSession = (
  home: string,
  cwd: string,
  a: Adapter,
): SessionRef | null => a.findSessions(home, cwd)[0] ?? null;

export const detectAgent = (home: string, cwd: string): AgentId[] =>
  (Object.values(ADAPTERS) as Adapter[])
    .filter((a) => a.findSessions(home, cwd).length > 0)
    .map((a) => a.id);
