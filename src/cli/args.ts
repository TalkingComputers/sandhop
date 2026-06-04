import type { AgentId } from "../core/ports/agent.js";
import type { Transport } from "../core/ports/transport.js";
import type { KeeponTransport } from "./config.js";
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
  transport?: KeeponTransport;
  profile: boolean;
}

const readFlag = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
};

const readAgent = (value: string | undefined): AgentId | undefined => {
  if (value === undefined) return undefined;
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unknown agent ${value}`);
};

export const readTransport = (value: string | undefined): KeeponTransport => {
  if (value === undefined) return "public";
  if (value === "public" || value === "cloudflared") return value;
  throw new Error("--tunnel must be 'public' or 'cloudflared'");
};

const readOptionalTransport = (
  value: string | undefined,
): KeeponTransport | undefined =>
  value === undefined ? undefined : readTransport(value);

const isProviderId = (value: string): value is ProviderId =>
  PROVIDER_IDS.includes(value as ProviderId);

export const readProvider = (value: string | undefined): ProviderId => {
  if (value === undefined) return "e2b";
  if (isProviderId(value)) return value;
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}`);
};

const readOptionalProvider = (
  value: string | undefined,
): ProviderId | undefined =>
  value === undefined ? undefined : readProvider(value);

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
    profile: !argv.includes("--no-profile"),
  };
};

export const buildTransport = (
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Transport => {
  if (args.transport !== "cloudflared") return new PublicTransport();
  return new CloudflaredTransport({
    token: env.CLOUDFLARE_TUNNEL_TOKEN,
    hostname: env.CLOUDFLARE_TUNNEL_HOSTNAME,
  });
};
