import type { Manifest } from "../manifest.js";
import { dirname, remotePath } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import type { Multiplexer } from "../ports/multiplexer.js";
import { EnrichmentStepId } from "../ports/progress.js";
import { execShell, type Sandbox } from "../ports/provider.js";
import { quote } from "shell-quote";
import {
  buildMergeClaudeMcpScript,
  buildPruneMcpTablesScript,
  renderNodeScript,
} from "../sandbox-scripts.js";
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
const SUDO_INIT =
  'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi';
const OWNER_INIT =
  'SANDHOP_OWNER="$(id -u):$(id -g)"; if [ "${SANDHOP_RUNTIME_USER:-}" != "" ]; then SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"; fi';
const ZSTD_INSTALL =
  "command -v zstd || $SUDO sh -lc 'command -v apt-get >/dev/null && (apt-get update && apt-get install -y zstd) || (command -v dnf >/dev/null && dnf install -y zstd) || (command -v apk >/dev/null && apk add zstd) || (command -v yum >/dev/null && yum install -y zstd)'";
const TTYD_INSTALL =
  "command -v ttyd || { $SUDO curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${TTYD_ARCH} -o /usr/local/bin/ttyd && $SUDO chmod +x /usr/local/bin/ttyd; }";
const REINSTALL_CMD_TIMEOUT_SECONDS = 180;

const shellPath = (path: string): string =>
  path.startsWith("$HOME") ? `"${path}"` : quote([path]);

const ignoreFailure = (cmd: string, label: string): string =>
  `${cmd} || { echo ${quote([`[sandhop] ${label} failed: ${cmd}`])} >&2; true; }`;

const renderMcpConfig = (agent: Agent, codePlan: CodePlan): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites);
  const dir = dirname(config.path);
  if (config.mode === "merge-claude-json")
    return [
      `mkdir -p ${shellPath(dir)}`,
      ...renderNodeScript(
        buildMergeClaudeMcpScript(config.path, config.content),
        "MCP_MERGE",
      ),
    ];
  const delimiter = `SANDHOP_MCP_CONFIG_${Date.now()}`;
  return [
    `mkdir -p ${shellPath(dir)}`,
    ...renderNodeScript(buildPruneMcpTablesScript(config.path), "MCP_PRUNE"),
    `cat >> ${shellPath(config.path)} <<'${delimiter}'`,
    config.content.trimEnd(),
    delimiter,
  ];
};

const renderMcpExcluded = (codePlan: CodePlan): string[] =>
  codePlan.excluded.map(
    (server) =>
      `echo ${quote([`[sandhop] mcp skipped: ${server.name} (${server.reason})`])}`,
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
    ...runtimes.map((cmd) => ignoreFailure(cmd, "runtime")),
    ...(runtimes.length === 0
      ? []
      : ['export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"']),
    ...codePlan.installCmds.map((cmd) => ignoreFailure(cmd, "install")),
  ];
};

const renderSummary = (steps: EnrichmentStepResult[]): string[] => [
  'echo "[sandhop] enrichment summary"',
  ...steps.map((step) =>
    step.ok
      ? `echo ${quote([`[sandhop] ok: ${step.step}`])}`
      : `echo ${quote([`[sandhop] failed: ${step.step}: ${step.error}`])}`,
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
      SUDO_INIT,
      OWNER_INIT,
      `$SUDO mkdir -p ${quote([path])}`,
      `$SUDO chown -R "$SANDHOP_OWNER" ${quote([path])}`,
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
    const prep = await execShell(sandbox, this.renderPathPrep(dirname(path)));
    if (prep.exitCode !== 0)
      throw new Error(
        `Path prep failed for ${dirname(path)}: stderr=${JSON.stringify(prep.stderr)} stdout=${JSON.stringify(prep.stdout)}`,
      );
    await sandbox.uploadFile(remotePath(path), content);
    const ownership = await execShell(
      sandbox,
      [
        "set -e",
        SUDO_INIT,
        OWNER_INIT,
        `$SUDO chown "$SANDHOP_OWNER" ${quote([path])}`,
      ].join("\n"),
    );
    if (ownership.exitCode !== 0)
      throw new Error(
        `Path ownership failed for ${path}: stderr=${JSON.stringify(ownership.stderr)} stdout=${JSON.stringify(ownership.stdout)}`,
      );
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
      SUDO_INIT,
      ARCH_SETUP,
      TTYD_INSTALL,
      ...this.multiplexer.install(),
      ...(opts.transportSteps ?? []),
      `${installCmd} || $SUDO env PATH="$PATH" ${installCmd}`,
      ...this.agent.preSeed(manifest.remoteProj),
      `git config --global --add safe.directory ${quote([manifest.remoteProj])}`,
      ...(opts.gitUserName === undefined
        ? []
        : [`git config --global user.name ${quote([opts.gitUserName])}`]),
      ...(opts.gitUserEmail === undefined
        ? []
        : [`git config --global user.email ${quote([opts.gitUserEmail])}`]),
      `dest=${quote([dest])}`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo SANDHOP_RESTORE_OK",
    ].join("\n");
  }

  renderEnrichmentSetup(): string {
    return ["set -e", SUDO_INIT, ZSTD_INSTALL].join("\n");
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
      SUDO_INIT,
      ignoreFailure(ZSTD_INSTALL, "zstd install"),
      ...renderMcpCode(opts.codePlan),
    ].join("\n");
  }

  renderSettingsScriptInstalls(plan: ScriptCapturePlan | null): string {
    if (plan === null || plan.installCmds.length === 0)
      return 'echo "[sandhop] settings script installs skipped"';
    return [
      SUDO_INIT,
      ...plan.installCmds.map((cmd) =>
        ignoreFailure(cmd, "settings script install"),
      ),
    ].join("\n");
  }

  renderReinstall(commands: string[]): string {
    if (commands.length === 0) return 'echo "[sandhop] reinstall skipped"';
    return [
      "export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1",
      ...commands.map(
        (command) =>
          `timeout ${REINSTALL_CMD_TIMEOUT_SECONDS} sh -lc ${quote([command])} || { echo ${quote([`[sandhop] reinstall step failed: ${command}`])} >&2; true; }`,
      ),
    ].join("\n");
  }

  renderEnrichmentCompletion(steps: EnrichmentStepResult[]): string {
    return [...renderSummary(steps), "touch /tmp/sandhop-enriched"].join("\n");
  }
}
