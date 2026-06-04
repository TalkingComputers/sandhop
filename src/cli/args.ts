import type { AgentId } from "../core/ports/agent.js";
import type { Transport } from "../core/ports/transport.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/index.js";
import { CloudflaredTransport } from "../transports/cloudflared.js";
import { PublicTransport } from "../transports/public.js";

export interface ParsedArgs {
  cmd: "push" | "list" | "kill";
  agent?: AgentId;
  session?: string;
  killId?: string;
  cwd: string;
  provider: ProviderId;
  transport: "public" | "cloudflared";
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

const readTransport = (value: string | undefined): "public" | "cloudflared" => {
  if (value === undefined) return "public";
  if (value === "public" || value === "cloudflared") return value;
  throw new Error("--tunnel must be 'public' or 'cloudflared'");
};

const isProviderId = (value: string): value is ProviderId =>
  PROVIDER_IDS.includes(value as ProviderId);

export const readProvider = (value: string | undefined): ProviderId => {
  if (value === undefined) return "e2b";
  if (isProviderId(value)) return value;
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}`);
};

export const parseArgs = (argv: string[], cwd: string): ParsedArgs => {
  const cmd = argv[0] === "list" || argv[0] === "kill" ? argv[0] : "push";
  return {
    cmd,
    agent: readAgent(readFlag(argv, "--agent")),
    session: readFlag(argv, "--session"),
    killId: cmd === "kill" ? argv[1] : undefined,
    cwd: readFlag(argv, "--cwd") ?? cwd,
    provider: readProvider(readFlag(argv, "--provider")),
    transport: readTransport(
      argv.includes("--tunnel") ? readFlag(argv, "--tunnel") : undefined,
    ),
    profile: !argv.includes("--no-profile"),
  };
};

export const buildTransport = (
  args: ParsedArgs,
  env: Record<string, string | undefined>,
): Transport => {
  if (args.transport === "public") return new PublicTransport();
  return new CloudflaredTransport({
    token: env.CLOUDFLARE_TUNNEL_TOKEN,
    hostname: env.CLOUDFLARE_TUNNEL_HOSTNAME,
  });
};
