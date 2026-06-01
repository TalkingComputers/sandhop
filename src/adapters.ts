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
  pkg: string;
  installCmd(version: string): string;
  resumeCmd(sessionId: string, remoteProj: string): string;
  remoteTranscriptPath(remoteEnc: string, transcriptName: string): string;
  preSeed(remoteProj: string): string[];
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
  pkg: "@anthropic-ai/claude-code",
  installCmd: (version) => `npm i -g @anthropic-ai/claude-code@${version}`,
  resumeCmd: (id, proj) => `cd ${proj} && claude --resume ${id}`,
  remoteTranscriptPath: (enc, name) => `$HOME/.claude/projects/${enc}/${name}`,
  preSeed: (remoteProj) => {
    const script = `const fs=require("fs");const f=process.env.HOME+"/.claude.json";const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};j.hasCompletedOnboarding=true;if(!Object.hasOwn(j,"projects"))j.projects={};j.projects[${JSON.stringify(remoteProj)}]={hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};if(process.env.ANTHROPIC_API_KEY){if(!Object.hasOwn(j,"customApiKeyResponses"))j.customApiKeyResponses={};j.customApiKeyResponses.approved=[process.env.ANTHROPIC_API_KEY.slice(-20)];j.customApiKeyResponses.rejected=[];}fs.writeFileSync(f,JSON.stringify(j))`;
    return [`node -e ${JSON.stringify(script)}`];
  },
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

const buildCodexPreSeedScript = (remoteProj: string): string =>
  [
    'const fs=require("fs")',
    'const f=process.env.HOME+"/.codex/config.toml"',
    `const project=${JSON.stringify(remoteProj)}`,
    'const projectHeader="[projects."+JSON.stringify(project)+"]"',
    'const root=["approval_policy = \\"never\\"","sandbox_mode = \\"danger-full-access\\"","cli_auth_credentials_store = \\"file\\""]',
    "const rootKey=/^(approval_policy|sandbox_mode|cli_auth_credentials_store)\\s*=/",
    'let lines=fs.existsSync(f)?fs.readFileSync(f,"utf8").split(/\\r?\\n/):[]',
    'if(lines.length===1&&lines[0]==="")lines=[]',
    "let table=false",
    "const kept=[]",
    "for(const line of lines){if(/^\\s*\\[/.test(line))table=true;if(!table&&rootKey.test(line.trim()))continue;kept.push(line)}",
    "const withoutProject=[]",
    "for(let i=0;i<kept.length;i++){if(kept[i].trim()===projectHeader){i++;while(i<kept.length&&!/^\\s*\\[/.test(kept[i]))i++;i--}else withoutProject.push(kept[i])}",
    'while(withoutProject[withoutProject.length-1]==="")withoutProject.pop()',
    "const firstTable=withoutProject.findIndex(line=>/^\\s*\\[/.test(line))",
    "const beforeRoot=firstTable===-1?withoutProject:withoutProject.slice(0,firstTable)",
    "const afterRoot=firstTable===-1?[]:withoutProject.slice(firstTable)",
    "const out=[...beforeRoot]",
    'if(out.length>0&&out[out.length-1]!=="")out.push("")',
    "out.push(...root)",
    'if(afterRoot.length>0)out.push("",...afterRoot)',
    'out.push("",projectHeader,"trust_level = \\"trusted\\"")',
    'fs.writeFileSync(f,out.join("\\n")+"\\n")',
  ].join(";");

export const CODEX: Adapter = {
  id: "codex",
  pkg: "@openai/codex",
  installCmd: (version) => `npm i -g @openai/codex@${version}`,
  resumeCmd: (id, proj) => `cd ${proj} && codex resume ${id}`,
  remoteTranscriptPath: (_enc, name) =>
    `$HOME/.codex/sessions/restored/${name}`,
  preSeed: (remoteProj) => [
    "mkdir -p $HOME/.codex",
    `node -e ${JSON.stringify(buildCodexPreSeedScript(remoteProj))}`,
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
