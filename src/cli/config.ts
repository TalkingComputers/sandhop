import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { joinPath } from "../core/paths.js";
import type { ProviderId } from "../providers/index.js";

export type KeeponTransport = "public" | "cloudflared";

export interface KeeponConfig {
  defaultProvider: ProviderId;
  transport: KeeponTransport;
  cloudflare?: { token?: string; hostname?: string };
  credentials: Record<string, string>;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const configDir = (home: string): string =>
  joinPath(
    process.env["XDG_CONFIG_HOME"] ?? joinPath(home, ".config"),
    "keepon",
  );

export const configPath = (home: string): string =>
  joinPath(configDir(home), "config.json");

export const loadConfig = (home: string): KeeponConfig | null => {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as KeeponConfig;
};

export const saveConfig = (home: string, cfg: KeeponConfig): void => {
  const dir = configDir(home);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const path = configPath(home);
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: FILE_MODE });
  chmodSync(path, FILE_MODE);
};

const setMissing = (
  env: Record<string, string | undefined>,
  key: string,
  value: string,
): void => {
  if (env[key] === undefined) env[key] = value;
};

export const applyConfigToEnv = (
  cfg: KeeponConfig,
  env: Record<string, string | undefined>,
): void => {
  for (const [key, value] of Object.entries(cfg.credentials))
    setMissing(env, key, value);
  setMissing(env, "KEEPON_PROVIDER", cfg.defaultProvider);
  setMissing(env, "KEEPON_TRANSPORT", cfg.transport);
  if (cfg.cloudflare?.token !== undefined)
    setMissing(env, "CLOUDFLARE_TUNNEL_TOKEN", cfg.cloudflare.token);
  if (cfg.cloudflare?.hostname !== undefined)
    setMissing(env, "CLOUDFLARE_TUNNEL_HOSTNAME", cfg.cloudflare.hostname);
};
