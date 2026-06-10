import { projectDirName } from "../encode.js";
import { dirname, expandHome } from "../paths.js";
import type { HostDeps } from "../ports/host.js";

export interface PathMapping {
  localPath: string;
  sandboxPath: string;
}

const SHELL_PATH_TOKEN =
  /(?:^|[\s"'(=;&|])((?:~\/|\$HOME\/|\$\{HOME\}\/|\/|\.\/|\.\.\/)[^"'`\s;&|)<>]+)/g;

export const shellPathTokens = (command: string): string[] =>
  [...command.matchAll(SHELL_PATH_TOKEN)].map((match) => match[1]!);

export const mapHomePath = (
  home: string,
  target: string,
  localPath: string,
  outside: "passthrough" | "mcp-root",
): string => {
  if (localPath === home) return target;
  if (localPath.startsWith(`${home}/`))
    return `${target}${localPath.slice(home.length)}`;
  return outside === "passthrough"
    ? localPath
    : `${target}/.sandhop/mcp-roots/${projectDirName(localPath)}`;
};

export const maybeRealpath = (
  host: Pick<HostDeps, "exists" | "realpath">,
  path: string,
): string | null => {
  if (!host.exists(path)) return null;
  return host.realpath(path);
};

export const gitRoot = (
  host: Pick<HostDeps, "exec" | "isDirectory">,
  path: string,
): string | null => {
  const start = host.isDirectory(path) ? path : dirname(path);
  try {
    const root = host
      .exec("git", ["-C", start, "rev-parse", "--show-toplevel"])
      .trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
};

export const sandboxPath = (
  host: HostDeps,
  sandboxHome: string,
  localPath: string,
): string => {
  return mapHomePath(host.home, sandboxHome, localPath, "mcp-root");
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replacePathPrefix = (value: string, from: string, to: string): string =>
  value.replace(
    new RegExp(`${escapeRegExp(from)}(?=/|$|[^A-Za-z0-9._-])`, "g"),
    () => to,
  );

export const remapValue = (
  value: string,
  host: HostDeps,
  sandboxHome: string,
  mappings: PathMapping[],
): string => {
  let next = expandHome(value, host.home);
  for (const mapping of [...mappings].sort(
    (a, b) => b.localPath.length - a.localPath.length,
  ))
    next = replacePathPrefix(next, mapping.localPath, mapping.sandboxPath);
  return replacePathPrefix(next, host.home, sandboxHome);
};
