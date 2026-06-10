import { createHash } from "node:crypto";
import { CLAUDE_JSON_PATH } from "../agents/claude-paths.js";
import { remotePath, type RemotePath } from "./paths.js";
import { quote } from "shell-quote";

export interface NodeScript {
  readonly path: RemotePath;
  readonly content: string;
}

export const renderChownToRuntimeUser = (
  paths: string[],
  recursive: boolean,
): string[] => [
  'SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"',
  ...paths.map(
    (path) =>
      `chown ${recursive ? "-R " : ""}"$SANDHOP_OWNER" ${quote([path])}`,
  ),
];

export const renderCreateOwnedDirs = (paths: string[]): string[] => [
  'SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"',
  ...paths.flatMap((path) => [
    `mkdir -p ${quote([path])}`,
    `d=${quote([path])}; while [ "$d" != "/" ]; do case "$d" in "$SANDHOP_RUNTIME_HOME"/*) chown "$SANDHOP_OWNER" "$d";; esac; d="$(dirname "$d")"; done`,
  ]),
];

export const buildNodeScript = (
  content: string,
  label: string,
): NodeScript => ({
  path: remotePath(
    `/tmp/sandhop-${label.toLowerCase().replaceAll("_", "-")}-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.js`,
  ),
  content,
});

export const renderNodeScript = (script: NodeScript): string[] => [
  `node ${quote([script.path])}`,
  `rm -f ${quote([script.path])}`,
];

export const buildClaudePreSeedScript = (
  remoteProj: string,
  carriedProjectState: Record<string, unknown>,
): string =>
  [
    'const fs=require("fs")',
    `const f=process.env.HOME+${JSON.stringify(`/${CLAUDE_JSON_PATH}`)}`,
    'const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{}',
    "j.hasCompletedOnboarding=true",
    'if(!Object.hasOwn(j,"projects"))j.projects={}',
    `j.projects[${JSON.stringify(remoteProj)}]={...${JSON.stringify(carriedProjectState)},hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true}`,
    'if(process.env.ANTHROPIC_API_KEY){if(!j.customApiKeyResponses||typeof j.customApiKeyResponses!=="object")j.customApiKeyResponses={};if(!Array.isArray(j.customApiKeyResponses.approved))j.customApiKeyResponses.approved=[];if(!Array.isArray(j.customApiKeyResponses.rejected))j.customApiKeyResponses.rejected=[];const suffix=process.env.ANTHROPIC_API_KEY.slice(-20);if(!j.customApiKeyResponses.approved.includes(suffix))j.customApiKeyResponses.approved.push(suffix)}',
    'const t=f+".sandhop.tmp"',
    "fs.writeFileSync(t,JSON.stringify(j))",
    "fs.renameSync(t,f)",
  ].join(";");

export const buildHomeWriteScript = (
  relPath: string,
  content: string,
): string =>
  [
    'const fs=require("fs")',
    'const path=require("path")',
    `const f=process.env.HOME+${JSON.stringify(`/${relPath}`)}`,
    "fs.mkdirSync(path.dirname(f),{recursive:true})",
    'const t=f+".sandhop.tmp"',
    `fs.writeFileSync(t,${JSON.stringify(content)})`,
    "fs.renameSync(t,f)",
  ].join(";");

export const buildCodexMcpConfigScript = (
  path: string,
  content: string,
): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}`,
    `const c=${JSON.stringify(`${content.trimEnd()}\n`)}`,
    'const lines=fs.readFileSync(f,"utf8").split(/\\r?\\n/)',
    "const out=[]",
    "let skip=false",
    "for(const line of lines){if(/^\\s*\\[mcp_servers(?:\\.|\\])/.test(line)){skip=true;continue}if(skip&&/^\\s*\\[/.test(line))skip=false;if(!skip)out.push(line)}",
    'const t=f+".sandhop.tmp"',
    'fs.writeFileSync(t,out.join("\\n").replace(/\\n*$/,"\\n")+c)',
    "fs.renameSync(t,f)",
  ].join(";");

export const buildMergeClaudeMcpScript = (
  path: string,
  content: string,
): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}`,
    `const s=JSON.parse(${JSON.stringify(content)})`,
    'const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{}',
    "j.mcpServers=s",
    'const t=f+".sandhop.tmp"',
    'fs.writeFileSync(t,JSON.stringify(j,null,2)+"\\n")',
    "fs.renameSync(t,f)",
  ].join(";");
