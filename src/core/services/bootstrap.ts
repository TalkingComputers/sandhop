import type { Manifest } from "../manifest.js";
import { dirname } from "../paths.js";
import type { Agent } from "../ports/agent.js";
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
} from "../shell.js";
import type { CodePlan } from "./mcp-code.js";
import type { ScriptCapturePlan } from "./scripts.js";

export interface BootstrapOptions {
  home: string;
  transportSteps?: string[];
}

export interface EnrichmentBootstrapOptions {
  codePlan?: CodePlan | null;
}

export type EnrichmentStepResult =
  | { name: string; ok: true }
  | { name: string; ok: false; error: string };

const ARCH_SETUP =
  'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) TTYD_ARCH=aarch64; CF_ARCH=arm64;; *) TTYD_ARCH=x86_64; CF_ARCH=amd64;; esac';
const ZSTD_INSTALL =
  "command -v zstd || $SUDO sh -lc 'command -v apt-get >/dev/null && (apt-get update && apt-get install -y zstd) || (command -v dnf >/dev/null && dnf install -y zstd) || (command -v apk >/dev/null && apk add zstd) || (command -v yum >/dev/null && yum install -y zstd)'";

const renderMcpConfig = (agent: Agent, codePlan: CodePlan): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites);
  const dir = dirname(config.path);
  if (config.mode === "merge-claude-json")
    return [
      `mkdir -p ${quoteHomePath(dir)}`,
      `node -e ${JSON.stringify(buildMergeClaudeMcpScript(config.path, config.content))}`,
    ];
  const redirect = config.mode === "append" ? ">>" : ">";
  return [
    `mkdir -p ${quoteHomePath(dir)}`,
    ...(config.mode === "append"
      ? [`node -e ${JSON.stringify(buildPruneMcpTablesScript(config.path))}`]
      : []),
    `cat ${redirect} ${quoteHomePath(config.path)} <<'SANDHOP_MCP_CONFIG'`,
    config.content.trimEnd(),
    "SANDHOP_MCP_CONFIG",
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
      ? `echo "[sandhop] ok: ${shellLog(step.name)}"`
      : `echo "[sandhop] failed: ${shellLog(step.name)}: ${shellLog(step.error)}"`,
  ),
];

export class BootstrapService {
  readonly agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
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
      "$SUDO curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd",
      "$SUDO chmod +x /usr/local/bin/ttyd",
      ...(opts.transportSteps ?? []),
      `${installCmd} || $SUDO env PATH="$PATH" ${installCmd}`,
      ...this.agent.preSeed(manifest.remoteProj),
      `$SUDO mkdir -p "${manifest.remoteProj}"`,
      `$SUDO chown -R "$(id -u):$(id -g)" "${manifest.remoteProj}"`,
      `git config --global --add safe.directory "${manifest.remoteProj}"`,
      `tar -xzf /tmp/bundle.tgz -C "${manifest.remoteProj}"`,
      `dest="${dest}"`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo SANDHOP_RESTORE_OK",
    ].join("\n");
  }

  renderEnrichmentSetup(): string {
    return ["set -e", SUDO_SETUP, LOW_PRIORITY_SETUP, ZSTD_INSTALL].join("\n");
  }

  renderEnrichmentConfig(
    remoteProj: string,
    opts: EnrichmentBootstrapOptions,
  ): string {
    if (opts.codePlan === null || opts.codePlan === undefined)
      return 'echo "[sandhop] mcp config skipped"';
    const excluded = renderMcpExcluded(opts.codePlan);
    const config = renderMcpConfig(this.agent, opts.codePlan);
    if (config.length === 0)
      return [...excluded, 'echo "[sandhop] mcp config skipped"'].join("\n");
    return [...excluded, ...config].join("\n");
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
          `${runLowPriority(command)} || { echo "[sandhop] reinstall step failed: ${shellLog(command)}" >&2; true; }`,
      ),
    ].join("\n");
  }

  renderEnrichmentCompletion(steps: EnrichmentStepResult[]): string {
    return [...renderSummary(steps), "touch /tmp/sandhop-enriched"].join("\n");
  }
}
