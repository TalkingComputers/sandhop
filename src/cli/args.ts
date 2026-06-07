import type { AgentId } from "../core/ports/agent.js";
import type { Transport } from "../core/ports/transport.js";
import type { SandhopTransport } from "./config.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/index.js";
import { CloudflaredTransport } from "../transports/cloudflared.js";
import { PublicTransport } from "../transports/public.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill" | "setup" | "help" | "version";
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
}

export const readFlag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

export const readAgent = (value: string | undefined): AgentId | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
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

const KNOWN_FLAGS = new Set([
  "--agent",
  "--session",
  "--cwd",
  "--provider",
  "--tunnel",
  "--exclude",
  "--include",
  "--no-profile",
  "--strict",
]);

const hasUnknownFlag = (argv: string[]): boolean =>
  argv.some((token) => token.startsWith("-") && !KNOWN_FLAGS.has(token));

const readCmd = (argv: string[]): ParsedArgs["cmd"] => {
  if (argv.includes("--version") || argv.includes("-v")) return "version";
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help")
    return "help";
  const first = argv[0];
  if (
    first === "push" ||
    first === "list" ||
    first === "kill" ||
    first === "setup"
  )
    return hasUnknownFlag(argv) ? "help" : first;
  return "help";
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  const cmd = readCmd(argv);
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
  };
};

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
