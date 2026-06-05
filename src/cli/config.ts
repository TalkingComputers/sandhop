import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isRecord } from "../core/json.js";
import { joinPath } from "../core/paths.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/index.js";

export type SandhopTransport = "public" | "cloudflared";

export interface SandhopConfig {
  defaultProvider: ProviderId;
  transport: SandhopTransport;
  cloudflare?: { token?: string; hostname?: string };
  credentials: Record<string, string>;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const CONFIG_NAMESPACE = "sandhop";

const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((field) => typeof field === "string");

const isCloudflareConfig = (
  value: unknown,
): value is SandhopConfig["cloudflare"] =>
  value === undefined ||
  (isRecord(value) &&
    (value.token === undefined || typeof value.token === "string") &&
    (value.hostname === undefined || typeof value.hostname === "string"));

const isSandhopConfig = (value: unknown): value is SandhopConfig =>
  isRecord(value) &&
  isStringRecord(value.credentials) &&
  isProviderId(value.defaultProvider) &&
  (value.transport === "public" || value.transport === "cloudflared") &&
  isCloudflareConfig(value.cloudflare);

export const configDir = (home: string): string =>
  joinPath(
    process.env["XDG_CONFIG_HOME"] ?? joinPath(home, ".config"),
    CONFIG_NAMESPACE,
  );

export const configPath = (home: string): string =>
  joinPath(configDir(home), "config.json");

export const loadConfig = (home: string): SandhopConfig | null => {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isSandhopConfig(parsed))
      throw new Error(`Invalid sandhop config at ${path}`);
    return parsed;
  } catch {
    throw new Error(`Invalid sandhop config at ${path}`);
  }
};

export const saveConfig = (home: string, cfg: SandhopConfig): void => {
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
  cfg: SandhopConfig,
  env: Record<string, string | undefined>,
): void => {
  for (const [key, value] of Object.entries(cfg.credentials))
    setMissing(env, key, value);
  setMissing(env, "SANDHOP_PROVIDER", cfg.defaultProvider);
  setMissing(env, "SANDHOP_TRANSPORT", cfg.transport);
  if (cfg.cloudflare?.token !== undefined)
    setMissing(env, "CLOUDFLARE_TUNNEL_TOKEN", cfg.cloudflare.token);
  if (cfg.cloudflare?.hostname !== undefined)
    setMissing(env, "CLOUDFLARE_TUNNEL_HOSTNAME", cfg.cloudflare.hostname);
};
