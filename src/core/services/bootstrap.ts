import type { Manifest } from "../manifest.js";
import { dirname } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { Multiplexer } from "../ports/multiplexer.js";
import { EnrichmentStepId } from "../ports/progress.js";
import type { Sandbox } from "../ports/provider.js";
import {
  buildMergeClaudeMcpScript,
  buildPruneMcpTablesScript,
} from "../sandbox-scripts.js";
import {
  LOW_PRIORITY_SETUP,
  SUDO_SETUP,
  nonFatal,
  quoteHomePath,
  runLowPriority,
  shellLog,
  shellQuote,
} from "../shell.js";
import type { CodePlan } from "./mcp-code.js";
import type { ScriptCapturePlan } from "./scripts.js";

export interface BootstrapOptions {
  home: string;
  transportSteps?: string[];
  gitUserName?: string;
  gitUserEmail?: string;
}

export interface EnrichmentBootstrapOptions {
  codePlan?: CodePlan | null;
}

export type EnrichmentStepResult =
  | { step: EnrichmentStepId; ok: true }
  | { step: EnrichmentStepId; ok: false; error: string };

const ARCH_SETUP =
  'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac';
const ZSTD_INSTALL =
  "command -v zstd || $SUDO sh -lc 'command -v apt-get >/dev/null && (apt-get update && apt-get install -y zstd) || (command -v dnf >/dev/null && dnf install -y zstd) || (command -v apk >/dev/null && apk add zstd) || (command -v yum >/dev/null && yum install -y zstd)'";
const TTYD_INSTALL =
  "command -v ttyd || { $SUDO curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd && $SUDO chmod +x /usr/local/bin/ttyd; }";
const REINSTALL_CMD_TIMEOUT_SECONDS = 180;

const renderMcpConfig = (agent: Agent, codePlan: CodePlan): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites);
  const dir = dirname(config.path);
  if (config.mode === "merge-claude-json")
    return [
      `mkdir -p ${quoteHomePath(dir)}`,
      `node -e ${shellQuote(buildMergeClaudeMcpScript(config.path, config.content))}`,
    ];
  const delimiter = `SANDHOP_MCP_CONFIG_${Date.now()}`;
  return [
    `mkdir -p ${quoteHomePath(dir)}`,
    `node -e ${shellQuote(buildPruneMcpTablesScript(config.path))}`,
    `cat >> ${quoteHomePath(config.path)} <<'${delimiter}'`,
    config.content.trimEnd(),
    delimiter,
  ];
};

const renderMcpExcluded = (codePlan: CodePlan): string[] =>
  codePlan.excluded.map(
    (server) =>
      `echo "[sandhop] mcp skipped: ${shellLog(server.name)} (${shellLog(server.reason)})"`,
  );

const renderMcpCode = (codePlan: CodePlan | null | undefined): string[] => {
  if (codePlan === null || codePlan === undefined) return [];
  const runtimes = [
    ...(codePlan.runtimes.has("bun")
      ? ["curl -fsSL https://bun.sh/install | bash"]
      : []),
    ...(codePlan.runtimes.has("uv")
      ? ["curl -LsSf https://astral.sh/uv/install.sh | sh"]
      : []),
  ];
  return [
    ...runtimes.map((cmd) => nonFatal(runLowPriority(cmd))),
    ...(runtimes.length === 0
      ? []
      : ['export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"']),
    ...codePlan.installCmds.map((cmd) => nonFatal(runLowPriority(cmd))),
  ];
};

const renderSummary = (steps: EnrichmentStepResult[]): string[] => [
  'echo "[sandhop] enrichment summary"',
  ...steps.map((step) =>
    step.ok
      ? `echo "[sandhop] ok: ${shellLog(step.step)}"`
      : `echo "[sandhop] failed: ${shellLog(step.step)}: ${shellLog(step.error)}"`,
  ),
];

export class BootstrapService {
  readonly agent: Agent;
  readonly multiplexer: Multiplexer;

  constructor(agent: Agent, multiplexer: Multiplexer) {
    this.agent = agent;
    this.multiplexer = multiplexer;
  }

  renderPathPrep(path: string): string {
    return [
      "set -e",
      SUDO_SETUP,
      `$SUDO mkdir -p ${shellQuote(path)}`,
      `$SUDO chown -R "$(id -u):$(id -g)" ${shellQuote(path)}`,
    ].join("\n");
  }

  renderProjectPrep(manifest: Manifest): string {
    return this.renderPathPrep(manifest.remoteProj);
  }

  async prepAndUpload(
    sandbox: Sandbox,
    path: string,
    content: Uint8Array | string,
  ): Promise<void> {
    const prep = await sandbox.exec(this.renderPathPrep(dirname(path)));
    if (prep.exitCode !== 0)
      throw new Error(
        `Path prep failed for ${dirname(path)}: stderr=${JSON.stringify(prep.stderr)} stdout=${JSON.stringify(prep.stdout)}`,
      );
    await sandbox.uploadFile(path, content);
  }

  render(manifest: Manifest, opts: BootstrapOptions): string {
    const installCmd = this.agent.installCmd(manifest.cliVersion);
    const dest = this.agent.remoteTranscriptPath(
      opts.home,
      manifest.remoteEnc,
      manifest.transcriptName,
    );
    return [
      "set -e",
      SUDO_SETUP,
      ARCH_SETUP,
      TTYD_INSTALL,
      ...this.multiplexer.install(),
      ...(opts.transportSteps ?? []),
      `${installCmd} || $SUDO env PATH="$PATH" ${installCmd}`,
      ...this.agent.preSeed(manifest.remoteProj),
      `git config --global --add safe.directory ${shellQuote(manifest.remoteProj)}`,
      ...(opts.gitUserName === undefined
        ? []
        : [`git config --global user.name ${shellQuote(opts.gitUserName)}`]),
      ...(opts.gitUserEmail === undefined
        ? []
        : [`git config --global user.email ${shellQuote(opts.gitUserEmail)}`]),
      `dest=${shellQuote(dest)}`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo SANDHOP_RESTORE_OK",
    ].join("\n");
  }

  renderEnrichmentSetup(): string {
    return ["set -e", SUDO_SETUP, LOW_PRIORITY_SETUP, ZSTD_INSTALL].join("\n");
  }

  renderEnrichmentConfig(opts: EnrichmentBootstrapOptions): string {
    if (opts.codePlan === null || opts.codePlan === undefined)
      return ["set -e", 'echo "[sandhop] mcp config skipped"'].join("\n");
    const excluded = renderMcpExcluded(opts.codePlan);
    const config = renderMcpConfig(this.agent, opts.codePlan);
    if (config.length === 0)
      return [
        "set -e",
        ...excluded,
        'echo "[sandhop] mcp config skipped"',
      ].join("\n");
    return ["set -e", ...excluded, ...config].join("\n");
  }

  renderEnrichmentInstalls(opts: EnrichmentBootstrapOptions): string {
    return [
      SUDO_SETUP,
      LOW_PRIORITY_SETUP,
      nonFatal(ZSTD_INSTALL),
      ...renderMcpCode(opts.codePlan),
    ].join("\n");
  }

  renderSettingsScriptInstalls(plan: ScriptCapturePlan | null): string {
    if (plan === null || plan.installCmds.length === 0)
      return 'echo "[sandhop] settings script installs skipped"';
    return [
      SUDO_SETUP,
      LOW_PRIORITY_SETUP,
      ...plan.installCmds.map((cmd) => nonFatal(runLowPriority(cmd))),
    ].join("\n");
  }

  renderReinstall(commands: string[]): string {
    if (commands.length === 0) return 'echo "[sandhop] reinstall skipped"';
    return [
      LOW_PRIORITY_SETUP,
      "export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1",
      ...commands.map(
        (command) =>
          `$SANDHOP_LOW_PRIORITY timeout ${REINSTALL_CMD_TIMEOUT_SECONDS} sh -lc ${shellQuote(command)} || { echo "[sandhop] reinstall step failed: ${shellLog(command)}" >&2; true; }`,
      ),
    ].join("\n");
  }

  renderEnrichmentCompletion(steps: EnrichmentStepResult[]): string {
    return [...renderSummary(steps), "touch /tmp/sandhop-enriched"].join("\n");
  }
}
