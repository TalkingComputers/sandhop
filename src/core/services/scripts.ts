import {
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_SETTINGS_PATH,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import { isRecord } from "../json.js";
import { expandEnv, joinPath } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import { installCmd } from "./mcp-classify.js";
import {
  gitRoot,
  maybeRealpath,
  remapValue,
  sandboxPath,
  shellPathTokens,
  type PathMapping,
} from "./mcp-paths.js";

export interface SettingsRewrite {
  localPath: string;
  sandboxPath: string;
  content: string;
}

export interface ScriptCapturePlan {
  mappings: PathMapping[];
  rewrites: SettingsRewrite[];
  installCmds: string[];
}

interface SettingsFile {
  localPath: string;
  sandboxPath: string;
  cwd: string;
}

interface ScriptToken {
  token: string;
  localPath: string;
  root: string;
}

interface RewriteContext {
  host: HostDeps;
  cwd: string;
  sandboxHome: string;
  roots: Set<string>;
}

const expandTokenPath = (
  host: HostDeps,
  token: string,
  cwd: string,
): string => {
  const expanded = expandEnv(token, host.home, host.env);
  if (expanded.startsWith("./") || expanded.startsWith("../"))
    return joinPath(cwd, expanded);
  return joinPath("/", expanded);
};

const readScriptRoot = (host: HostDeps, localPath: string): string => {
  const root = gitRoot(host, localPath);
  if (root !== null) return root;
  return localPath;
};

const readScriptTokens = (
  host: HostDeps,
  command: string,
  cwd: string,
): ScriptToken[] => {
  const scripts: ScriptToken[] = [];
  for (const token of shellPathTokens(command)) {
    const expanded = expandTokenPath(host, token, cwd);
    const real = maybeRealpath(host, expanded);
    if (real === null || host.isDirectory(real)) continue;
    scripts.push({ token, localPath: real, root: readScriptRoot(host, real) });
  }
  return scripts;
};

const mapScriptPath = (
  host: HostDeps,
  sandboxHome: string,
  token: ScriptToken,
): string => {
  const mapping = {
    localPath: token.root,
    sandboxPath: sandboxPath(host, sandboxHome, token.root),
  };
  return remapValue(token.localPath, host, sandboxHome, [mapping]);
};

const rewriteCommand = (
  ctx: RewriteContext,
  command: string,
): { command: string; changed: boolean } => {
  let next = command;
  let changed = false;
  for (const token of readScriptTokens(ctx.host, command, ctx.cwd)) {
    ctx.roots.add(token.root);
    next = next
      .split(token.token)
      .join(mapScriptPath(ctx.host, ctx.sandboxHome, token));
    changed = true;
  }
  return { command: next, changed };
};

const rewriteCommandField = (
  ctx: RewriteContext,
  record: Record<string, unknown>,
): boolean => {
  const command = record.command;
  if (typeof command !== "string") return false;
  const rewritten = rewriteCommand(ctx, command);
  if (!rewritten.changed) return false;
  record.command = rewritten.command;
  return true;
};

const rewriteHookGroups = (ctx: RewriteContext, value: unknown): boolean => {
  if (!isRecord(value)) return false;
  let changed = false;
  for (const entries of Object.values(value)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (isRecord(hook) && rewriteCommandField(ctx, hook)) changed = true;
      }
    }
  }
  return changed;
};

const STRING_COMMAND_SETTINGS = [
  "apiKeyHelper",
  "otelHeadersHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
] as const;

const RECORD_COMMAND_SETTINGS = ["statusLine", "fileSuggestion"] as const;

const rewriteStringCommand = (
  ctx: RewriteContext,
  settings: Record<string, unknown>,
  key: string,
): boolean => {
  const command = settings[key];
  if (typeof command !== "string") return false;
  const rewritten = rewriteCommand(ctx, command);
  if (!rewritten.changed) return false;
  settings[key] = rewritten.command;
  return true;
};

const rewriteSettings = (
  host: HostDeps,
  cwd: string,
  sandboxHome: string,
  settings: Record<string, unknown>,
  roots: Set<string>,
): boolean => {
  const ctx: RewriteContext = { host, cwd, sandboxHome, roots };
  let changed = false;
  if (rewriteHookGroups(ctx, settings.hooks)) changed = true;
  for (const key of RECORD_COMMAND_SETTINGS) {
    const value = settings[key];
    if (isRecord(value) && rewriteCommandField(ctx, value)) changed = true;
  }
  for (const key of STRING_COMMAND_SETTINGS)
    if (rewriteStringCommand(ctx, settings, key)) changed = true;
  return changed;
};

const settingsFiles = (
  host: HostDeps,
  cwd: string,
  sandboxHome: string,
): SettingsFile[] =>
  [CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_LOCAL_PATH].flatMap((path) => [
    {
      localPath: joinClaudeLocalPath(host.home, path),
      sandboxPath: `${sandboxHome}/${path}`,
      cwd,
    },
    {
      localPath: `${cwd}/${path}`,
      sandboxPath: `${cwd}/${path}`,
      cwd,
    },
  ]);

export class ScriptCaptureService {
  readonly host: HostDeps;

  constructor(host: HostDeps) {
    this.host = host;
  }

  plan(cwd: string, sandboxHome: string): ScriptCapturePlan {
    const roots = new Set<string>();
    const rewrites: SettingsRewrite[] = [];
    for (const file of settingsFiles(this.host, cwd, sandboxHome)) {
      const text = this.host.readFile(file.localPath);
      if (text === null) continue;
      const settings = JSON.parse(text) as unknown;
      if (!isRecord(settings))
        throw new Error(`Expected settings object at ${file.localPath}`);
      if (!rewriteSettings(this.host, file.cwd, sandboxHome, settings, roots))
        continue;
      rewrites.push({
        localPath: file.localPath,
        sandboxPath: file.sandboxPath,
        content: `${JSON.stringify(settings, null, 2)}\n`,
      });
    }
    const mappings = [...roots].sort().map((localPath) => ({
      localPath,
      sandboxPath: sandboxPath(this.host, sandboxHome, localPath),
    }));
    const installCmds = mappings.flatMap((mapping) =>
      this.host.isDirectory(mapping.localPath) &&
      gitRoot(this.host, mapping.localPath) !== null
        ? installCmd(this.host, mapping.localPath, mapping.sandboxPath)
        : [],
    );
    return { mappings, rewrites, installCmds };
  }
}
