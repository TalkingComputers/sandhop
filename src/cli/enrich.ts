import { pickAgent } from "../agents/index.js";
import type { Agent } from "../core/ports/agent.js";
import type { HostDeps } from "../core/ports/host.js";
import type { EnrichmentProgressListener } from "../core/ports/progress.js";
import type { Sandbox } from "../core/ports/provider.js";
import {
  EnrichmentService,
  type EnrichmentReport,
  type EnrichmentServices,
} from "../core/services/enrichment.js";
import { McpCodeService } from "../core/services/mcp-code.js";
import { ProfileService } from "../core/services/profile.js";
import { ReinstallService } from "../core/services/reinstall.js";
import { ScriptCaptureService } from "../core/services/scripts.js";
import { TransferService } from "../core/services/transfer.js";

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
): EnrichmentServices => ({
  sandbox,
  transfer: new TransferService(host, sandbox),
  profile: new ProfileService(host, agent),
  mcpCode: new McpCodeService(host, agent),
  reinstall: new ReinstallService(host, agent),
  scripts: new ScriptCaptureService(host),
});

export const runEnrichment = async (
  args: EnrichArgs,
  host: HostDeps,
  sandbox: Sandbox,
  onEvent?: EnrichmentProgressListener,
): Promise<EnrichmentReport> => {
  const agent = pickAgent(args.agent);
  return new EnrichmentService(
    agent,
    buildEnrichmentServices(host, agent, sandbox),
    args.excludes,
  ).run(args.cwd, args.profile, onEvent);
};
