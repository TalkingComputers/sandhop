import { safeRemoteProj } from "../encode.js";
import { expandEnv, joinPath } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import { installCmd } from "./mcp-classify.js";
import {
  hasRootMarker,
  LOCAL_PATH_EXCLUDES,
  maybeRealpath,
  nearestRoot,
  remapValue,
  sandboxPath,
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
  roots: Set<string>;
}

export { LOCAL_PATH_EXCLUDES };

const PATH_TOKEN =
  /(?:^|[\s"'(=;&|])((?:~\/|\$HOME\/|\$\{HOME\}\/|\/|\.\/|\.\.\/)[^"'`\s;&|)<>]*)/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePath = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (absolute) return `/${normalized}`;
  return normalized;
};

const expandTokenPath = (
  host: HostDeps,
  token: string,
  cwd: string,
): string => {
  const expanded = expandEnv(token, host.home, host.env);
  if (expanded.startsWith("./") || expanded.startsWith("../"))
    return normalizePath(joinPath(cwd, expanded));
  return normalizePath(expanded);
};

const readScriptRoot = (host: HostDeps, localPath: string): string => {
  const root = nearestRoot(host, localPath);
  return hasRootMarker(host, root) ? root : localPath;
};

const readScriptTokens = (
  host: HostDeps,
  command: string,
  cwd: string,
): ScriptToken[] => {
  const scripts: ScriptToken[] = [];
  for (const match of command.matchAll(PATH_TOKEN)) {
    const token = match[1]!;
    const expanded = expandTokenPath(host, token, cwd);
    const real = maybeRealpath(host, expanded);
    if (real === null || host.isDirectory(real)) continue;
    scripts.push({ token, localPath: real, root: readScriptRoot(host, real) });
  }
  return scripts;
};

const mapScriptPath = (host: HostDeps, token: ScriptToken): string => {
  const mapping = {
    localPath: token.root,
    sandboxPath: sandboxPath(host, token.root),
  };
  return remapValue(token.localPath, host, [mapping]);
};

const rewriteCommand = (
  ctx: RewriteContext,
  command: string,
): { command: string; changed: boolean } => {
  let next = command;
  let changed = false;
  for (const token of readScriptTokens(ctx.host, command, ctx.cwd)) {
    ctx.roots.add(token.root);
    next = next.split(token.token).join(mapScriptPath(ctx.host, token));
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

const rewriteApiKeyHelper = (
  ctx: RewriteContext,
  settings: Record<string, unknown>,
): boolean => {
  const helper = settings.apiKeyHelper;
  if (typeof helper !== "string") return false;
  const rewritten = rewriteCommand(ctx, helper);
  if (!rewritten.changed) return false;
  settings.apiKeyHelper = rewritten.command;
  return true;
};

const rewriteSettings = (
  host: HostDeps,
  cwd: string,
  settings: Record<string, unknown>,
  roots: Set<string>,
): boolean => {
  const ctx: RewriteContext = { host, cwd, roots };
  let changed = false;
  if (rewriteHookGroups(ctx, settings.hooks)) changed = true;
  if (
    isRecord(settings.statusLine) &&
    rewriteCommandField(ctx, settings.statusLine)
  )
    changed = true;
  if (rewriteApiKeyHelper(ctx, settings)) changed = true;
  return changed;
};

const settingsFiles = (host: HostDeps, cwd: string): SettingsFile[] => [
  {
    localPath: `${host.home}/.claude/settings.json`,
    sandboxPath: "/home/user/.claude/settings.json",
    cwd,
  },
  {
    localPath: `${cwd}/.claude/settings.json`,
    sandboxPath: `${safeRemoteProj(cwd).dir}/.claude/settings.json`,
    cwd,
  },
];

export class ScriptCaptureService {
  readonly host: HostDeps;

  constructor(host: HostDeps) {
    this.host = host;
  }

  plan(cwd: string): ScriptCapturePlan {
    const roots = new Set<string>();
    const rewrites: SettingsRewrite[] = [];
    for (const file of settingsFiles(this.host, cwd)) {
      const text = this.host.readFile(file.localPath);
      if (text === null) continue;
      const settings = JSON.parse(text) as unknown;
      if (!isRecord(settings))
        throw new Error(`Expected settings object at ${file.localPath}`);
      if (!rewriteSettings(this.host, file.cwd, settings, roots)) continue;
      rewrites.push({
        localPath: file.localPath,
        sandboxPath: file.sandboxPath,
        content: `${JSON.stringify(settings, null, 2)}\n`,
      });
    }
    const mappings = [...roots].sort().map((localPath) => ({
      localPath,
      sandboxPath: sandboxPath(this.host, localPath),
    }));
    const installCmds = mappings.flatMap((mapping) =>
      this.host.isDirectory(mapping.localPath) &&
      hasRootMarker(this.host, mapping.localPath)
        ? installCmd(this.host, mapping.localPath, mapping.sandboxPath)
        : [],
    );
    return { mappings, rewrites, installCmds };
  }
}
