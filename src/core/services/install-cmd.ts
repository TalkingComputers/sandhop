import { joinPath } from "../paths.js";
import type { HostDeps } from "../ports/host.js";

type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

const packageManagerFor = (
  host: HostDeps,
  dir: string,
): PackageManager | null => {
  if (!host.exists(joinPath(dir, "package.json"))) return null;
  if (host.exists(joinPath(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (host.exists(joinPath(dir, "yarn.lock"))) return "yarn";
  if (host.exists(joinPath(dir, "package-lock.json"))) return "npm";
  if (host.exists(joinPath(dir, "bun.lock"))) return "bun";
  if (host.exists(joinPath(dir, "bun.lockb"))) return "bun";
  return null;
};

export const installCommandFor = (
  host: HostDeps,
  dir: string,
): string | null => {
  const packageManager = packageManagerFor(host, dir);
  if (packageManager === "pnpm") return "pnpm install --frozen-lockfile";
  if (packageManager === "yarn") return "yarn install --frozen-lockfile";
  if (packageManager === "npm") return "npm ci";
  if (packageManager === "bun") return "bun install --frozen-lockfile";
  if (host.exists(joinPath(dir, "poetry.lock"))) return "poetry install";
  if (host.exists(joinPath(dir, "pdm.lock"))) return "pdm install";
  if (host.exists(joinPath(dir, "uv.lock"))) return "uv sync";
  if (host.exists(joinPath(dir, "requirements.txt")))
    return "uv pip install -r requirements.txt --system";
  return null;
};

export const buildCommandFor = (host: HostDeps, dir: string): string | null => {
  const packageManager = packageManagerFor(host, dir);
  if (packageManager === null) return null;
  const text = host.readFile(joinPath(dir, "package.json"));
  if (text === null) return null;
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("scripts" in parsed) ||
    typeof parsed.scripts !== "object" ||
    parsed.scripts === null ||
    !("build" in parsed.scripts) ||
    typeof parsed.scripts.build !== "string"
  )
    return null;
  return `${packageManager} run build`;
};
