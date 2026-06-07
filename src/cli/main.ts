#!/usr/bin/env node
import { intro, note, outro, progress } from "@clack/prompts";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  detectAgents,
  pickAgent,
  selectDefaultAgent,
} from "../agents/index.js";
import { CredentialError } from "../core/errors.js";
import type { Agent } from "../core/ports/agent.js";
import {
  EnrichmentStepId,
  PushProgressId,
  type EnrichmentProgressListener,
  type PushProgressListener,
} from "../core/ports/progress.js";
import { AuthService } from "../core/services/auth.js";
import { BootstrapService } from "../core/services/bootstrap.js";
import { GitSshService } from "../core/services/git-ssh.js";
import { SecretsService } from "../core/services/secrets.js";
import { SessionService } from "../core/services/session.js";
import { TeleportService } from "../core/services/teleport.js";
import { VersionService } from "../core/services/version.js";
import type { NodeHost } from "../host/node.js";
import { TmuxMultiplexer } from "../multiplexers/tmux.js";
import { buildProvider, type ProviderId } from "../providers/index.js";
import {
  buildTransport,
  parseArgs,
  readProvider,
  readTransport,
  type ParsedArgs,
} from "./args.js";
import { applyConfigToEnv, loadConfig } from "./config.js";
import { runEnrichment } from "./enrich.js";
import { buildHost } from "./host.js";
import {
  formatEnrichmentProgress,
  formatPushProgress,
} from "./progress-labels.js";
import { runSetup } from "./setup.js";
import { HELP_TEXT, VERSION } from "./usage.js";

type RuntimeArgs = Omit<ParsedArgs, "provider"> & {
  provider: ProviderId;
};

type PushReporter = {
  onPushProgress: PushProgressListener;
  onEnrichmentProgress: EnrichmentProgressListener;
  finishTeleport(): void;
  failTeleport(): void;
  startEnrichment(): void;
  failEnrichment(): void;
  finishEnrichment(
    enrichment: Awaited<ReturnType<typeof runEnrichment>>,
    strict: boolean,
    failed: boolean,
  ): void;
  printResult(result: Awaited<ReturnType<TeleportService["run"]>>): void;
};

const ENRICHMENT_STEP_COUNT = Object.keys(EnrichmentStepId).length;
const BYTES_PER_MB = 1_048_576;

const hasFailedStep = (
  steps: Awaited<ReturnType<typeof runEnrichment>>,
): boolean => steps.some((step) => !step.ok);

const formatStrictFailure = (
  steps: Awaited<ReturnType<typeof runEnrichment>>,
): string => {
  const failed = steps.filter((step) => !step.ok);
  return `Enrichment failed in strict mode: ${failed.map((step) => step.step).join(", ")}`;
};

const createPushReporter = (tty: boolean): PushReporter => {
  if (!tty)
    return {
      onPushProgress: (event): void => console.log(formatPushProgress(event)),
      onEnrichmentProgress: (event): void => {
        if (event.kind === "enrichStep") {
          console.log(formatEnrichmentProgress(event));
          return;
        }
        console.log(
          `${event.transfer.label} ${event.transfer.phase} ${event.transfer.bytesDone}/${event.transfer.bytesTotal}`,
        );
      },
      finishTeleport: (): void => undefined,
      failTeleport: (): void => undefined,
      startEnrichment: (): void => undefined,
      failEnrichment: (): void => undefined,
      finishEnrichment: (): void => undefined,
      printResult: (result): void => {
        console.log(`SANDHOP_URL ${result.url}`);
        console.log(`SANDHOP_AUTH ${result.user}:${result.pass}`);
      },
    };

  intro("sandhop push");
  const pushProgress = progress({ style: "heavy", max: 6 });
  const enrichmentProgress = progress({
    style: "heavy",
    max: ENRICHMENT_STEP_COUNT,
  });
  let lastEnrichmentLabel = "Preparing";
  pushProgress.start("Teleporting your session…");

  return {
    onPushProgress: (event): void => {
      if (event.step === PushProgressId.Ready) return;
      pushProgress.advance(1, formatPushProgress(event));
    },
    onEnrichmentProgress: (event): void => {
      if (event.kind === "enrichStep") {
        const label = formatEnrichmentProgress(event);
        lastEnrichmentLabel = label;
        if (event.status === "start") {
          enrichmentProgress.message(label);
          return;
        }
        enrichmentProgress.advance(1, label);
        return;
      }
      enrichmentProgress.message(
        `${lastEnrichmentLabel} · ${Math.round(event.transfer.bytesDone / BYTES_PER_MB)}MB`,
      );
    },
    finishTeleport: (): void => pushProgress.stop("Session teleported"),
    failTeleport: (): void => pushProgress.error("Teleport failed"),
    startEnrichment: (): void =>
      enrichmentProgress.start("Syncing profile, MCP servers & skills…"),
    failEnrichment: (): void => enrichmentProgress.error("Enrichment failed"),
    finishEnrichment: (enrichment, strict, failed): void => {
      const completedSteps = enrichment.filter((step) => step.ok).length;
      if (failed && strict) {
        enrichmentProgress.error(
          `Enrichment failed · ${completedSteps}/${enrichment.length}`,
        );
        return;
      }
      enrichmentProgress.stop(
        `Environment ready · ${completedSteps}/${enrichment.length}`,
      );
    },
    printResult: (result): void => {
      note(
        `${result.url}\n\n  user   ${result.user}\n  pass   ${result.pass}\n  kill   sandhop kill ${result.sandboxId}`,
        "Open in your browser",
      );
      outro("Environment ready.");
    },
  };
};

export const withRuntimeDefaults = (
  args: ParsedArgs,
  host: NodeHost,
): RuntimeArgs => {
  const config = loadConfig(host.home);
  if (config !== null) applyConfigToEnv(config, host.env);
  return {
    ...args,
    provider: args.provider ?? readProvider(host.env["SANDHOP_PROVIDER"]),
  };
};

const runPush = async (args: RuntimeArgs, host: NodeHost): Promise<void> => {
  const provider = buildProvider(args.provider, host);
  const transport =
    args.transport ?? readTransport(host.env["SANDHOP_TRANSPORT"]);
  const detected =
    args.agent === undefined ? detectAgents(host, args.cwd) : undefined;
  let agent: Agent;
  if (args.agent === undefined) {
    if (detected === undefined) throw new Error("Agent detection failed");
    agent = selectDefaultAgent(host, args.cwd, detected);
  } else {
    agent = pickAgent(args.agent);
  }
  const multiplexer = new TmuxMultiplexer();
  const sessions = agent.matchSession(host, args.cwd);
  if (sessions.length === 0)
    throw new Error(
      args.agent === undefined
        ? `No Claude Code or Codex session found for ${args.cwd}`
        : `No ${agent.id} session found for ${args.cwd}`,
    );
  if (detected !== undefined && detected.length > 1)
    console.error(`Multiple agents found; using ${agent.id}`);
  const service = new TeleportService(provider, agent, {
    host,
    session: new SessionService(host, agent),
    secrets: new SecretsService(host, agent),
    auth: new AuthService(host, agent),
    version: new VersionService(host, agent),
    bootstrap: new BootstrapService(agent, multiplexer),
    gitSsh: new GitSshService(host),
    multiplexer,
  });
  const reporter = createPushReporter(process.stdout.isTTY === true);
  let result: Awaited<ReturnType<TeleportService["run"]>>;
  try {
    result = await service.run(args.cwd, {
      sessionId: args.session,
      transport: buildTransport({ transport }, host.env),
      excludes: args.excludes,
      includes: args.includes,
      timeoutMs: 3_600_000,
      onProgress: reporter.onPushProgress,
    });
  } catch (error: unknown) {
    reporter.failTeleport();
    throw error;
  }
  reporter.finishTeleport();
  reporter.startEnrichment();
  let enrichment: Awaited<ReturnType<typeof runEnrichment>>;
  try {
    enrichment = await runEnrichment(
      {
        agent: agent.id,
        cwd: args.cwd,
        excludes: args.excludes,
        profile: args.profile,
      },
      host,
      result.sandbox,
      reporter.onEnrichmentProgress,
    );
  } catch (error: unknown) {
    reporter.failEnrichment();
    throw error;
  }
  const failed = hasFailedStep(enrichment);
  reporter.finishEnrichment(enrichment, args.strict, failed);
  if (failed && args.strict) throw new Error(formatStrictFailure(enrichment));
  reporter.printResult(result);
};

export const main = async (argv: string[]): Promise<void> => {
  const args = parseArgs(argv, process.cwd());
  if (args.cmd === "version") {
    console.log(VERSION);
    return;
  }
  if (args.cmd === "help") {
    console.log(HELP_TEXT);
    return;
  }
  if (args.cmd === "setup") {
    await runSetup(buildHost());
    return;
  }
  const host = buildHost();
  const runtimeArgs = withRuntimeDefaults(args, host);
  if (args.cmd === "list") {
    const provider = buildProvider(runtimeArgs.provider, host);
    for (const sandbox of await provider.list())
      console.log(`${sandbox.id}\t${sandbox.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    const provider = buildProvider(runtimeArgs.provider, host);
    if (args.killId === undefined)
      throw new Error("kill requires a sandbox id");
    console.log((await provider.destroy(args.killId)) ? "killed" : "not found");
    return;
  }
  await runPush(runtimeArgs, host);
  process.exit(0);
};

const formatCliError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CredentialError)
    return `${message}\nRun \`sandhop setup\` to configure a provider.`;
  return message;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
