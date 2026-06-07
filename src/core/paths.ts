import { tmpdir } from "node:os";
import { posix } from "node:path";
import type { HostDeps } from "./ports/host.js";

export const dirname = posix.dirname;
export const basename = posix.basename;
export const joinPath = posix.join;

export const expandHome = (path: string, home: string): string =>
  path
    .replace(/^~/, home)
    .replaceAll("${HOME}", home)
    .replaceAll("$HOME", home);

export const expandEnv = (
  value: string,
  home: string,
  env: Record<string, string | undefined>,
): string =>
  expandHome(value, home).replace(
    /\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g,
    (token, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      if (name === undefined) return token;
      const envValue = env[name];
      return envValue === undefined ? token : envValue;
    },
  );

export const makeTempPath = (name: string): string =>
  `${tmpdir()}/sandhop-${Date.now()}-${name}`;

export const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

export const listSkillNames = (
  host: HostDeps,
  skillsRoot: string,
): string[] => {
  if (!host.exists(skillsRoot)) return [];
  return uniqueSorted(
    host
      .walk(skillsRoot)
      .map((path) => path.slice(skillsRoot.length + 1))
      .filter((path) => path.length > 0)
      .map((path) => path.split("/")[0]!),
  );
};
