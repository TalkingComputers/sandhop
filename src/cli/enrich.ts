import { pickAgent } from "../agents/index.js";
import type { Agent } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { EnrichmentProgressListener } from "../core/ports/progress.js";
import type { Sandbox } from "../core/ports/provider.js";
import {
  BootstrapService,
  type EnrichmentStepResult,
} from "../core/services/bootstrap.js";
import {
  EnrichmentService,
  type EnrichmentServices,
} from "../core/services/enrichment.js";
import { McpCodeService } from "../core/services/mcp-code.js";
import { ProfileService } from "../core/services/profile.js";
import { ReinstallService } from "../core/services/reinstall.js";
import { SecretsService } from "../core/services/secrets.js";
import { ScriptCaptureService } from "../core/services/scripts.js";
import { TransferService } from "../core/services/transfer.js";
import { TmuxMultiplexer } from "../multiplexers/tmux.js";

export interface EnrichArgs {
  agent: Agent["id"];
  cwd: string;
  excludes: string[];
  profile: boolean;
}

const buildEnrichmentServices = (
  host: HostDeps,
  agent: Agent,
  sandbox: Sandbox,
): EnrichmentServices => {
  const multiplexer = new TmuxMultiplexer();
  return {
    sandbox,
    transfer: new TransferService(host, sandbox),
    profile: new ProfileService(host, agent),
    mcpCode: new McpCodeService(host, agent),
    reinstall: new ReinstallService(host, agent),
    secrets: new SecretsService(host, agent),
    scripts: new ScriptCaptureService(host),
    bootstrap: new BootstrapService(agent, multiplexer),
  };
};

export const runEnrichment = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
  onEvent?: EnrichmentProgressListener,
): Promise<EnrichmentStepResult[]> => {
  const agent = pickAgent(args.agent);
  return new EnrichmentService(
    agent,
    buildEnrichmentServices(host, agent, sandbox),
    args.excludes,
  ).run(args.cwd, args.profile, onEvent);
};
