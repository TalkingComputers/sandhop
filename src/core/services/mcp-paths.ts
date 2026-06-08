import { projectDirName } from "../encode.js";
import { dirname, expandHome } from "../paths.js";
import type { HostDeps } from "../ports/host.js";

export interface PathMapping {
  localPath: string;
  sandboxPath: string;
}

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

export const maybeRealpath = (host: HostDeps, path: string): string | null => {
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

export const projectRoot = (
  host: Pick<HostDeps, "exec" | "isDirectory">,
  path: string,
): string => {
  const root = gitRoot(host, path);
  if (root === null)
    throw new Error(`Git root not found for MCP path: ${path}`);
  return root;
};

export const sandboxPath = (
  host: HostDeps,
  sandboxHome: string,
  localPath: string,
): string => {
  return mapHomePath(host.home, sandboxHome, localPath, "mcp-root");
};

const replaceAll = (value: string, from: string, to: string): string =>
  value.split(from).join(to);

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
    next = replaceAll(next, mapping.localPath, mapping.sandboxPath);
  return replaceAll(next, host.home, sandboxHome);
};
