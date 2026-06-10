#!/usr/bin/env node
import { intro, note, outro, progress } from "@clack/prompts";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveSession } from "../agents/index.js";
import { CredentialError } from "../core/errors.js";
import {
  EnrichmentStepId,
  PushProgressId,
  type EnrichmentProgressListener,
  type PushProgressListener,
  type TransferProgress,
} from "../core/ports/progress.js";
import type { EnrichmentReport } from "../core/services/enrichment.js";
import { GitSshService, type SshCollector } from "../core/services/git-ssh.js";
import { SecretsService } from "../core/services/secrets.js";
import { TeleportService } from "../core/services/teleport.js";
import { detectVersion } from "../core/services/version.js";
import type { NodeHost } from "../host/node.js";
import { TmuxMultiplexer } from "../multiplexers/tmux.js";
import {
  buildProvider,
  resolveCredentials,
  type ProviderId,
} from "../providers/index.js";
import {
  buildTransport,
  parseArgs,
  readProvider,
  readTransport,
  type ParsedArgs,
} from "./args.js";
import { loadConfig, type SandhopConfig } from "./config.js";
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
  config: SandhopConfig | null;
};

type PushReporter = {
  onPushProgress: PushProgressListener;
  onTransfer: (transfer: TransferProgress) => void;
  onEnrichmentProgress: EnrichmentProgressListener;
  finishTeleport(): void;
  failTeleport(): void;
  startEnrichment(): void;
  finishEnrichment(report: EnrichmentReport): void;
  printResult(result: Awaited<ReturnType<TeleportService["run"]>>): void;
};

const ENRICHMENT_STEP_COUNT = Object.keys(EnrichmentStepId).length;
const PUSH_STEP_COUNT = Object.keys(PushProgressId).length;
const BYTES_PER_MB = 1_048_576;
const SANDBOX_TIMEOUT_MS = 86_400_000;

const firstLine = (text: string): string => text.split("\n", 1)[0]!;

const formatEnrichmentNotes = (report: EnrichmentReport): string[] => [
  ...report.steps.flatMap((step) =>
    step.ok
      ? []
      : [
          `failed   ${formatEnrichmentProgress({ kind: "enrichStep", step: step.step, status: "fail" })} — ${firstLine(step.error)}`,
        ],
  ),
  ...report.mcpExcluded.map(
    (server) => `skipped  MCP ${server.name} (${server.reason})`,
  ),
];

const createPushReporter = (tty: boolean): PushReporter => {
  if (!tty)
    return {
      onPushProgress: (event): void => console.log(formatPushProgress(event)),
      onTransfer: (transfer): void =>
        console.log(
          `${transfer.label} ${transfer.phase} ${transfer.bytesDone}/${transfer.bytesTotal}`,
        ),
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
      finishEnrichment: (report): void => {
        for (const line of formatEnrichmentNotes(report))
          console.log(`SANDHOP_ENRICH ${line}`);
      },
      printResult: (result): void => {
        console.log(`SANDHOP_URL ${result.url}`);
        console.log(`SANDHOP_AUTH ${result.user}:${result.pass}`);
        if (result.sshHosts.length > 0)
          console.log(`SANDHOP_SSH_HOSTS ${result.sshHosts.join(",")}`);
      },
    };

  intro("sandhop push");
  const pushProgress = progress({ style: "heavy", max: PUSH_STEP_COUNT });
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
    onTransfer: (transfer): void => {
      if (transfer.phase !== "upload") return;
      pushProgress.message(
        `${formatPushProgress({ step: PushProgressId.UploadingBundle })} · ${Math.round(transfer.bytesDone / BYTES_PER_MB)}/${Math.round(transfer.bytesTotal / BYTES_PER_MB)}MB`,
      );
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
    finishEnrichment: (report): void => {
      const completedSteps = report.steps.filter((step) => step.ok).length;
      enrichmentProgress.stop(
        `Environment ready · ${completedSteps}/${report.steps.length} steps ok`,
      );
      const lines = formatEnrichmentNotes(report);
      if (lines.length > 0) note(lines.join("\n"), "Enrichment notes");
    },
    printResult: (result): void => {
      const sshLine =
        result.sshHosts.length === 0
          ? ""
          : `\n  ssh    keys for ${result.sshHosts.join(", ")} sent (skip with --no-ssh)`;
      note(
        `${result.url}\n\n  user   ${result.user}\n  pass   ${result.pass}${sshLine}\n  kill   sandhop kill ${result.sandboxId}`,
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
  return {
    ...args,
    config,
    provider:
      args.provider ??
      readProvider(host.env["SANDHOP_PROVIDER"] ?? config?.defaultProvider),
  };
};

const buildRuntimeProvider = (
  args: RuntimeArgs,
  host: NodeHost,
): ReturnType<typeof buildProvider> =>
  buildProvider(
    args.provider,
    host,
    resolveCredentials(args.provider, host.env, args.config?.credentials),
  );

const runPush = async (args: RuntimeArgs, host: NodeHost): Promise<void> => {
  const provider = await buildRuntimeProvider(args, host);
  const transport =
    args.transport ??
    readTransport(host.env["SANDHOP_TRANSPORT"] ?? args.config?.transport);
  const cloudflare = {
    token:
      host.env["CLOUDFLARE_TUNNEL_TOKEN"] ?? args.config?.cloudflare?.token,
    hostname:
      host.env["CLOUDFLARE_TUNNEL_HOSTNAME"] ??
      args.config?.cloudflare?.hostname,
  };
  const { agent, session, detectedAgents } = resolveSession(
    host,
    args.cwd,
    args.agent,
    args.session,
  );
  if (detectedAgents.length > 1)
    console.error(`Multiple agents found; using ${agent.id}`);
  const multiplexer = new TmuxMultiplexer();
  const gitSsh: SshCollector = args.ssh
    ? new GitSshService(host)
    : { collect: () => ({ files: [], dirs: [], hosts: [] }) };
  const service = new TeleportService(provider, agent, {
    host,
    session,
    secrets: new SecretsService(host, agent),
    auth: () => agent.authEnv(host),
    version: () => detectVersion(host, agent),
    gitSsh,
    multiplexer,
  });
  const reporter = createPushReporter(process.stdout.isTTY === true);
  let result: Awaited<ReturnType<TeleportService["run"]>>;
  try {
    result = await service.run(args.cwd, {
      transport: buildTransport(transport, cloudflare),
      excludes: args.excludes,
      includes: args.includes,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      onProgress: reporter.onPushProgress,
      onTransfer: reporter.onTransfer,
      beforeTerminalStart: async (sandbox): Promise<void> => {
        reporter.startEnrichment();
        const report = await runEnrichment(
          {
            agent: agent.id,
            cwd: args.cwd,
            excludes: args.excludes,
            profile: args.profile,
          },
          host,
          sandbox,
          reporter.onEnrichmentProgress,
        );
        reporter.finishEnrichment(report);
      },
    });
  } catch (error: unknown) {
    reporter.failTeleport();
    throw error;
  }
  reporter.finishTeleport();
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
    const provider = await buildRuntimeProvider(runtimeArgs, host);
    for (const sandbox of await provider.list())
      console.log(`${sandbox.id}\t${sandbox.startedAt.toISOString()}`);
    return;
  }
  if (args.cmd === "kill") {
    const provider = await buildRuntimeProvider(runtimeArgs, host);
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
