import { projectDirName } from "../encode.js";
import { dirname, expandHome, joinPath, SANDBOX_HOME } from "../paths.js";
import type { HostDeps } from "../ports/host.js";

export interface PathMapping {
  localPath: string;
  sandboxPath: string;
}

export const LOCAL_PATH_EXCLUDES = ["node_modules", ".venv", ".git"];

const MARKERS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "bun.lock",
  ".git",
];

export const maybeRealpath = (host: HostDeps, path: string): string | null => {
  if (!host.exists(path)) return null;
  return host.realpath(path);
};

export const hasRootMarker = (host: HostDeps, path: string): boolean =>
  MARKERS.some((marker) => host.exists(joinPath(path, marker)));

export const nearestRoot = (host: HostDeps, path: string): string => {
  const start = host.isDirectory(path) ? path : dirname(path);
  let current = start;
  for (;;) {
    if (hasRootMarker(host, current)) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
};

export const sandboxPath = (host: HostDeps, localPath: string): string => {
  if (localPath === host.home) return SANDBOX_HOME;
  if (localPath.startsWith(`${host.home}/`))
    return `${SANDBOX_HOME}${localPath.slice(host.home.length)}`;
  return `${SANDBOX_HOME}/.keepon/mcp-roots/${projectDirName(localPath)}`;
};

const replaceAll = (value: string, from: string, to: string): string =>
  value.split(from).join(to);

export const remapValue = (
  value: string,
  host: HostDeps,
  mappings: PathMapping[],
): string => {
  let next = expandHome(value, host.home);
  for (const mapping of [...mappings].sort(
    (a, b) => b.localPath.length - a.localPath.length,
  ))
    next = replaceAll(next, mapping.localPath, mapping.sandboxPath);
  return replaceAll(next, host.home, SANDBOX_HOME);
};
