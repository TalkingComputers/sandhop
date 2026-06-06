import type { AgentId } from "../core/ports/agent.js";
import type { Transport } from "../core/ports/transport.js";
import type { SandhopTransport } from "./config.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/index.js";
import { CloudflaredTransport } from "../transports/cloudflared.js";
import { PublicTransport } from "../transports/public.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill" | "setup";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
  provider?: ProviderId;
  transport?: SandhopTransport;
  excludes: string[];
  includes: string[];
  profile: boolean;
  strict: boolean;
  detach: boolean;
}

export interface EnrichArgs {
  agent: AgentId;
  cwd: string;
  excludes: string[];
  profile: boolean;
  progressFile?: string;
}

export interface ParsedEnrichArgs extends EnrichArgs {
  sandboxId: string;
  provider: ProviderId;
  strict: boolean;
}

export const readFlag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

const readRequiredFlag = (argv: string[], name: string): string => {
  const value = readFlag(argv, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};

export const readAgent = (value: string | undefined): AgentId | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
};

const readRequiredAgent = (value: string): AgentId => {
  const agent = readAgent(value);
  if (agent === undefined) throw new Error("--agent is required");
  return agent;
};

export const readTransport = (value: string | undefined): SandhopTransport => {
  if (value === undefined)
    throw new Error("pass --tunnel or run `sandhop setup`");
  if (value === "public" || value === "cloudflared") return value;
  throw new Error("--tunnel must be 'public' or 'cloudflared'");
};

const readOptionalTransport = (
  value: string | undefined,
): SandhopTransport | undefined =>
  value === undefined ? undefined : readTransport(value);

const isProviderId = (value: string): value is ProviderId =>
  PROVIDER_IDS.includes(value as ProviderId);

export const readProvider = (value: string | undefined): ProviderId => {
  if (value === undefined)
    throw new Error("pass --provider or run `sandhop setup`");
  if (isProviderId(value)) return value;
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}`);
};

const readOptionalProvider = (
  value: string | undefined,
): ProviderId | undefined =>
  value === undefined ? undefined : readProvider(value);

const readCsvFlags = (argv: string[], name: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    values.push(...value.split(",").filter((item) => item.length > 0));
  }
  return values;
};

export const readExcludes = (argv: string[]): string[] =>
  readCsvFlags(argv, "--exclude");

export const readIncludes = (argv: string[]): string[] =>
  readCsvFlags(argv, "--include");

const readCmd = (value: string | undefined): ParsedArgs["cmd"] => {
  if (value === "list" || value === "kill" || value === "setup") return value;
  return "push";
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  const cmd = readCmd(argv[0]);
  return {
    cmd,
    agent: readAgent(readFlag(argv, "--agent")),
    session: readFlag(argv, "--session"),
    killId: cmd === "kill" ? argv[1] : undefined,
    cwd: readFlag(argv, "--cwd") ?? cwd,
    provider: readOptionalProvider(readFlag(argv, "--provider")),
    transport: readOptionalTransport(
      argv.includes("--tunnel") ? readFlag(argv, "--tunnel") : undefined,
    ),
    excludes: readExcludes(argv),
    includes: readIncludes(argv),
    profile: !argv.includes("--no-profile"),
    strict: argv.includes("--strict"),
    detach: argv.includes("--detach"),
  };
};

export const parseEnrichArgs = (argv: string[]): ParsedEnrichArgs => ({
  sandboxId: readRequiredFlag(argv, "--sandbox-id"),
  agent: readRequiredAgent(readRequiredFlag(argv, "--agent")),
  cwd: readRequiredFlag(argv, "--cwd"),
  provider: readProvider(readRequiredFlag(argv, "--provider")),
  progressFile: readFlag(argv, "--progress-file"),
  excludes: readExcludes(argv),
  profile: !argv.includes("--no-profile"),
  strict: argv.includes("--strict"),
});

export const buildTransport = (
  args: { transport: SandhopTransport },
  hostEnv: Record<string, string | undefined>,
): Transport => {
  if (args.transport === "public") return new PublicTransport();
  if (args.transport === "cloudflared")
    return new CloudflaredTransport({
      token: hostEnv.CLOUDFLARE_TUNNEL_TOKEN,
      hostname: hostEnv.CLOUDFLARE_TUNNEL_HOSTNAME,
    });
  throw new Error(`Unknown transport ${args.transport}`);
};
