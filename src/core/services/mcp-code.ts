import { projectDirName } from "../encode.js";
import type { Agent, McpServer } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export type McpServerClassification =
  | "remote-installable"
  | "local-path"
  | "remote-url"
  | "excluded";

export type McpRuntime = "bun" | "uv";

export interface PathMapping {
  localPath: string;
  sandboxPath: string;
}

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

export interface CodePlan {
  mappings: PathMapping[];
  rewrites: McpServer[];
  runtimes: Set<McpRuntime>;
  installCmds: string[];
  referencedFiles: string[];
  envRefs: string[];
  excluded: ExcludedServer[];
  classifications: ClassifiedServer[];
}

const SANDBOX_HOME = "/home/user";
const EXCLUDES = ["node_modules", ".venv", ".git"];
const MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "bun.lock",
  ".git",
];

const dirname = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
};

const basename = (path: string): string =>
  path.replace(/\/+$/, "").split("/").pop()!;

const joinPath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

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

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const addEnvRefs = (refs: Set<string>, value: string): void => {
  for (const match of value.matchAll(
    /(?:\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*))/g,
  )) {
    const name = match[1] ?? match[2];
    if (name !== undefined && name !== "HOME") refs.add(name);
  }
};

const expandEnv = (
  value: string,
  home: string,
  env: Record<string, string | undefined>,
): string =>
  value
    .replace(/^~/, home)
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home)
    .replace(
      /\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g,
      (token, braced: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare;
        if (name === undefined) return token;
        const envValue = env[name];
        return envValue === undefined ? token : envValue;
      },
    );

const expandHomeOnly = (value: string, home: string): string =>
  value
    .replace(/^~/, home)
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home);

const maybeRealpath = (host: HostDeps, path: string): string | null => {
  if (!host.exists(path)) return null;
  return host.realpath(path);
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

const nearestRoot = (host: HostDeps, path: string): string => {
  const start = host.isDirectory(path) ? path : dirname(path);
  let current = start;
  for (;;) {
    if (MARKERS.some((marker) => host.exists(joinPath(current, marker))))
      return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
};

const sandboxPath = (host: HostDeps, localPath: string): string => {
  if (localPath === host.home) return SANDBOX_HOME;
  if (localPath.startsWith(`${host.home}/`))
    return `${SANDBOX_HOME}${localPath.slice(host.home.length)}`;
  return `${SANDBOX_HOME}/.keepon/mcp-roots/${projectDirName(localPath)}`;
};

const replaceAll = (value: string, from: string, to: string): string =>
  value.split(from).join(to);

const remapValue = (
  value: string,
  host: HostDeps,
  mappings: PathMapping[],
): string => {
  let next = expandHomeOnly(value, host.home);
  for (const mapping of [...mappings].sort(
    (a, b) => b.localPath.length - a.localPath.length,
  ))
    next = replaceAll(next, mapping.localPath, mapping.sandboxPath);
  return replaceAll(next, host.home, SANDBOX_HOME);
};

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

const collectReferencedInputs = (
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

const candidatePaths = (host: HostDeps, server: McpServer): string[] => {
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

const addRuntime = (
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

const installCmd = (
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

const classify = (
  host: HostDeps,
  server: McpServer,
  paths: string[],
): { kind: McpServerClassification; reason?: string } => {
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

const rewriteServer = (
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

export class McpCodeService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  plan(cwd: string): CodePlan {
    const servers = this.agent.parseMcpServers(this.host, cwd);
    const mappings: PathMapping[] = [];
    const roots = new Set<string>();
    const runtimes = new Set<McpRuntime>();
    const installCmds: string[] = [];
    const referencedFiles = new Set<string>();
    const envRefs = new Set<string>();
    const excluded: ExcludedServer[] = [];
    const classifications: ClassifiedServer[] = [];
    const rewrites: McpServer[] = [];
    const localServers: { server: McpServer; paths: string[] }[] = [];

    for (const server of servers) {
      const referenced = collectReferencedInputs(this.host, server);
      for (const file of referenced.referencedFiles) referencedFiles.add(file);
      for (const ref of referenced.envRefs) envRefs.add(ref);
      const paths = candidatePaths(this.host, server);
      const classification = classify(this.host, server, paths);
      classifications.push({ name: server.name, kind: classification.kind });
      if (classification.kind === "excluded") {
        excluded.push({ name: server.name, reason: classification.reason! });
        continue;
      }
      if (classification.kind === "local-path") {
        const root = nearestRoot(this.host, paths[0]!);
        if (!roots.has(root)) {
          roots.add(root);
          const mapped = sandboxPath(this.host, root);
          mappings.push({ localPath: root, sandboxPath: mapped });
          installCmds.push(...installCmd(this.host, root, mapped));
        }
        addRuntime(this.host, server, paths, root, runtimes);
        localServers.push({ server, paths });
        continue;
      }
      rewrites.push(server);
    }

    const localRewrites = localServers.map((localServer) =>
      rewriteServer(this.host, localServer.server, mappings),
    );

    return {
      mappings,
      rewrites: [...localRewrites, ...rewrites],
      runtimes,
      installCmds,
      referencedFiles: uniqueSorted(referencedFiles),
      envRefs: uniqueSorted(envRefs),
      excluded,
      classifications,
    };
  }

  async build(cwd: string, outPath: string): Promise<CodePlan | null> {
    const plan = this.plan(cwd);
    if (plan.classifications.length === 0) return null;
    if (plan.mappings.length > 0) {
      const entries = plan.mappings.map((mapping) => {
        if (!mapping.localPath.startsWith(`${this.host.home}/`))
          throw new Error(
            `Cannot package MCP path outside host home: ${mapping.localPath}`,
          );
        return mapping.localPath.slice(this.host.home.length + 1);
      });
      await this.host.tarGz(this.host.home, entries, outPath, {
        excludes: EXCLUDES,
      });
    }
    return plan;
  }
}
