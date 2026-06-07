import { parseArgs as parseCliArgs, type ArgsDef } from "citty";
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

const CLI_ARGS = {
  command: { type: "positional", required: false },
  agent: { type: "string" },
  session: { type: "string" },
  cwd: { type: "string" },
  provider: { type: "string" },
  tunnel: { type: "string" },
  exclude: { type: "string" },
  include: { type: "string" },
  profile: { type: "boolean", default: true },
  strict: { type: "boolean", default: false },
} as const satisfies ArgsDef;

const COMMANDS = new Set<ParsedArgs["cmd"]>(["push", "list", "kill", "setup"]);

const VALUE_OPTIONS = new Set([
  "--agent",
  "--session",
  "--cwd",
  "--provider",
  "--tunnel",
  "--exclude",
  "--include",
]);

const BOOLEAN_OPTIONS = new Set([
  "--profile",
  "--no-profile",
  "--strict",
  "--help",
  "-h",
  "--version",
  "-v",
]);

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

const readOptionName = (token: string): string => {
  const equalsIndex = token.indexOf("=");
  return equalsIndex < 0 ? token : token.slice(0, equalsIndex);
};

const hasUnknownOption = (argv: string[]): boolean =>
  argv.some((token) => {
    if (!token.startsWith("-") || token === "--") return false;
    const name = readOptionName(token);
    return !VALUE_OPTIONS.has(name) && !BOOLEAN_OPTIONS.has(name);
  });

const assertOptionValues = (argv: string[]): void => {
  for (const [index, token] of argv.entries()) {
    const name = readOptionName(token);
    if (!VALUE_OPTIONS.has(name) || token.includes("=")) continue;
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
  }
};

const readCsvOptionValues = (argv: string[], name: string): string[] => {
  const values: string[] = [];
  for (const [index, token] of argv.entries()) {
    if (token === name) {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--"))
        throw new Error(`${name} requires a value`);
      values.push(...value.split(",").filter((item) => item.length > 0));
      continue;
    }
    if (!token.startsWith(`${name}=`)) continue;
    const value = token.slice(name.length + 1);
    if (value === "") throw new Error(`${name} requires a value`);
    values.push(...value.split(",").filter((item) => item.length > 0));
  }
  return values;
};

export const readExcludes = (argv: string[]): string[] =>
  readCsvOptionValues(argv, "--exclude");

export const readIncludes = (argv: string[]): string[] =>
  readCsvOptionValues(argv, "--include");

const readCmd = (argv: string[]): ParsedArgs["cmd"] => {
  if (argv.includes("--version") || argv.includes("-v")) return "version";
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help")
    return "help";
  const parsed = parseCliArgs(argv, CLI_ARGS);
  const command = parsed.command;
  if (typeof command === "string" && COMMANDS.has(command))
    return hasUnknownOption(argv) ? "help" : command;
  return "help";
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  assertOptionValues(argv);
  const cmd = readCmd(argv);
  const parsed = parseCliArgs(argv, CLI_ARGS);
  return {
    cmd,
    agent: readAgent(parsed.agent),
    session: parsed.session,
    killId: cmd === "kill" ? argv[1] : undefined,
    cwd: parsed.cwd ?? cwd,
    provider: readOptionalProvider(parsed.provider),
    transport: readOptionalTransport(parsed.tunnel),
    excludes: readExcludes(argv),
    includes: readIncludes(argv),
    profile: parsed.profile !== false,
    strict: parsed.strict === true,
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
