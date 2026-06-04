import { collectEnvRefs } from "../env.js";
import { basename, expandEnv, joinPath, uniqueSorted } from "../paths.js";
import type { McpServer } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { type PathMapping, maybeRealpath, remapValue } from "./mcp-paths.js";

export type McpServerClassification =
  | "remote-installable"
  | "local-path"
  | "remote-url"
  | "excluded";

export type McpRuntime = "bun" | "uv";

export interface ClassifiedServer {
  name: string;
  kind: McpServerClassification;
}

export interface ExcludedServer {
  name: string;
  reason: string;
}

export interface ReferencedInputs {
  envRefs: string[];
  referencedFiles: string[];
}

export interface LocalServer {
  server: McpServer;
  paths: string[];
}

const isHomePath = (path: string): boolean =>
  path.startsWith("~/") ||
  path === "~" ||
  path.startsWith("$HOME") ||
  path.startsWith("${HOME}");

const isPathLike = (value: string): boolean =>
  value.startsWith("/") ||
  value.startsWith("./") ||
  value.startsWith("../") ||
  isHomePath(value);

const addEnvRefs = (refs: Set<string>, value: string): void => {
  for (const name of collectEnvRefs(value)) if (name !== "HOME") refs.add(name);
};

const toCandidatePath = (
  host: HostDeps,
  value: string,
  cwd: string | undefined,
): string | null => {
  const expanded = expandEnv(value, host.home, host.env);
  if (isPathLike(expanded)) return expanded;
  if (cwd !== undefined && isPathLike(cwd) && value.includes("/"))
    return joinPath(expandEnv(cwd, host.home, host.env), expanded);
  return null;
};

const hasMagic = (bytes: Uint8Array, values: number[]): boolean =>
  values.every((value, index) => bytes[index] === value);

const isBinary = (host: HostDeps, path: string): boolean => {
  if (host.isDirectory(path)) return false;
  const text = host.readFile(path);
  if (text !== null && text.startsWith("#!")) return false;
  const bytes = host.readBytes(path);
  return (
    hasMagic(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    hasMagic(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    hasMagic(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    hasMagic(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    hasMagic(bytes, [0xce, 0xfa, 0xed, 0xfe])
  );
};

const isAppBundlePath = (path: string): boolean =>
  /\/Applications\/[^/]+\.app\//.test(path);

const LOCAL_BIND_PATTERN =
  /(^|[^a-z])(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)([^a-z]|$)/i;

const localBindValues = (server: McpServer): string[] => {
  const values: string[] = [];
  if (server.url !== undefined) values.push(server.url);
  if (server.args !== undefined) values.push(...server.args);
  if (server.env !== undefined) values.push(...Object.values(server.env));
  return values;
};

const hasLocalBindValue = (server: McpServer): boolean =>
  localBindValues(server).some((value) => LOCAL_BIND_PATTERN.test(value));

const readSourceFiles = (
  host: HostDeps,
  refs: Set<string>,
  text: string,
): string[] => {
  const files: string[] = [];
  for (const match of text.matchAll(
    /(?:^|[;&|]\s*)source\s+(["']?)([^"'\s;&|]+)\1/g,
  )) {
    const file = expandEnv(match[2]!, host.home, host.env);
    addEnvRefs(refs, match[2]!);
    const real = maybeRealpath(host, file);
    if (real !== null) files.push(real);
  }
  return files;
};

const bashCommandTexts = (server: McpServer): string[] => {
  if (server.args === undefined) return [];
  const command = server.command === undefined ? "" : basename(server.command);
  if (command !== "bash" && command !== "sh") return [];
  const texts: string[] = [];
  for (let index = 0; index < server.args.length - 1; index += 1) {
    const arg = server.args[index];
    if (arg === "-c" || arg === "-lc") texts.push(server.args[index + 1]!);
  }
  return texts;
};

export const collectReferencedInputs = (
  host: HostDeps,
  server: McpServer,
): ReferencedInputs => {
  const refs = new Set<string>();
  const files: string[] = [];
  if (server.command !== undefined) addEnvRefs(refs, server.command);
  if (server.cwd !== undefined) addEnvRefs(refs, server.cwd);
  if (server.args !== undefined)
    for (const arg of server.args) addEnvRefs(refs, arg);
  if (server.env !== undefined)
    for (const [key, value] of Object.entries(server.env)) {
      refs.add(key);
      addEnvRefs(refs, value);
    }
  for (const text of bashCommandTexts(server))
    files.push(...readSourceFiles(host, refs, text));
  return { envRefs: uniqueSorted(refs), referencedFiles: uniqueSorted(files) };
};

const bashLocalPaths = (host: HostDeps, server: McpServer): string[] => {
  const sourced = new Set(
    collectReferencedInputs(host, server).referencedFiles,
  );
  const paths: string[] = [];
  for (const text of bashCommandTexts(server)) {
    for (const match of text.matchAll(
      /(?:^|[\s;&|])((?:\/|~\/|\$HOME|\$\{HOME\})[^\s;&|]+)/g,
    )) {
      const expanded = expandEnv(match[1]!, host.home, host.env);
      const real = maybeRealpath(host, expanded);
      if (real !== null && !sourced.has(real)) paths.push(real);
    }
  }
  return paths;
};

export const candidatePaths = (host: HostDeps, server: McpServer): string[] => {
  const paths: string[] = [];
  const cwd = server.cwd;
  if (cwd !== undefined) {
    const candidate = toCandidatePath(host, cwd, undefined);
    const real = candidate === null ? null : maybeRealpath(host, candidate);
    if (real !== null) paths.push(real);
  }
  if (server.command !== undefined) {
    const candidate = toCandidatePath(host, server.command, cwd);
    const real = candidate === null ? null : maybeRealpath(host, candidate);
    if (real !== null) paths.push(real);
  }
  if (server.args !== undefined) {
    for (const arg of server.args) {
      const candidate = toCandidatePath(host, arg, cwd);
      const real = candidate === null ? null : maybeRealpath(host, candidate);
      if (real !== null) paths.push(real);
    }
  }
  paths.push(...bashLocalPaths(host, server));
  return uniqueSorted(paths);
};

const commandName = (server: McpServer): string =>
  server.command === undefined ? "" : basename(server.command);

const hasRuntimeShebang = (
  host: HostDeps,
  paths: string[],
  runtime: McpRuntime,
): boolean =>
  paths.some((path) => {
    if (host.isDirectory(path)) return false;
    const text = host.readFile(path);
    return text !== null && text.split("\n", 1)[0]!.includes(runtime);
  });

export const addRuntime = (
  host: HostDeps,
  server: McpServer,
  paths: string[],
  root: string,
  runtimes: Set<McpRuntime>,
): void => {
  const name = commandName(server);
  if (
    name === "bun" ||
    name === "bunx" ||
    host.exists(joinPath(root, "bun.lock")) ||
    hasRuntimeShebang(host, paths, "bun")
  )
    runtimes.add("bun");
  if (
    name === "uv" ||
    name === "uvx" ||
    host.exists(joinPath(root, "uv.lock")) ||
    hasRuntimeShebang(host, paths, "uv")
  )
    runtimes.add("uv");
};

export const installCmd = (
  host: HostDeps,
  root: string,
  sandboxRoot: string,
): string[] => {
  const cmds: string[] = [];
  if (host.exists(joinPath(root, "package.json"))) {
    if (host.exists(joinPath(root, "bun.lock")))
      cmds.push(`cd ${sandboxRoot} && bun install`);
    else if (host.exists(joinPath(root, "package-lock.json")))
      cmds.push(`cd ${sandboxRoot} && npm ci`);
    else cmds.push(`cd ${sandboxRoot} && npm install`);
  }
  if (
    host.exists(joinPath(root, "pyproject.toml")) ||
    host.exists(joinPath(root, "uv.lock"))
  )
    cmds.push(`cd ${sandboxRoot} && uv sync`);
  else if (host.exists(joinPath(root, "requirements.txt")))
    cmds.push(
      `cd ${sandboxRoot} && uv pip install -r requirements.txt --system`,
    );
  return cmds;
};

export const classify = (
  host: HostDeps,
  server: McpServer,
  paths: string[],
): { kind: McpServerClassification; reason?: string } => {
  if (hasLocalBindValue(server))
    return {
      kind: "excluded",
      reason: "binds to localhost / loopback (unreachable from sandbox)",
    };
  if (
    server.url !== undefined ||
    server.transport === "http" ||
    server.transport === "sse"
  )
    return { kind: "remote-url" };
  const appPath = paths.find(isAppBundlePath);
  if (appPath !== undefined)
    return { kind: "excluded", reason: "path inside an app bundle" };
  const binaryPath = paths.find((path) => isBinary(host, path));
  if (binaryPath !== undefined)
    return { kind: "excluded", reason: "non-shebang binary" };
  if (paths.length > 0) return { kind: "local-path" };
  return { kind: "remote-installable" };
};

export const rewriteServer = (
  host: HostDeps,
  server: McpServer,
  mappings: PathMapping[],
): McpServer => ({
  name: server.name,
  transport: server.transport,
  ...(server.command === undefined
    ? {}
    : { command: remapValue(server.command, host, mappings) }),
  ...(server.args === undefined
    ? {}
    : { args: server.args.map((arg) => remapValue(arg, host, mappings)) }),
  ...(server.env === undefined
    ? {}
    : {
        env: Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [
            key,
            remapValue(value, host, mappings),
          ]),
        ),
      }),
  ...(server.cwd === undefined
    ? {}
    : { cwd: remapValue(server.cwd, host, mappings) }),
  ...(server.url === undefined ? {} : { url: server.url }),
});
