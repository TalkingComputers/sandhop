import { quote } from "shell-quote";
import { dirname, expandHome } from "../paths.js";
import type { Agent } from "../ports/agent.js";
import { EnrichmentStepId } from "../ports/progress.js";
import type { Sandbox } from "../ports/provider.js";
import {
  buildCodexMcpConfigScript,
  buildMergeClaudeMcpScript,
  buildNodeScript,
  renderNodeScript,
  type NodeScript,
} from "../sandbox-scripts.js";
import type { CodePlan } from "./mcp-code.js";
import { uploadOwnedFiles } from "./sandbox-files.js";
import type { ScriptCapturePlan } from "./scripts.js";

export type EnrichmentStepResult =
  | { step: EnrichmentStepId; ok: true }
  | { step: EnrichmentStepId; ok: false; error: string };

const ZSTD_INSTALL = "command -v zstd";
const REINSTALL_CMD_TIMEOUT_SECONDS = 180;

const buildMcpConfigScripts = (
  config: ReturnType<Agent["formatMcpConfig"]>,
  home: string,
): NodeScript[] => {
  const path = expandHome(config.path, home);
  return config.mode === "merge-mcp-servers"
    ? [
        buildNodeScript(
          buildMergeClaudeMcpScript(path, config.content),
          "MCP_MERGE",
        ),
      ]
    : [
        buildNodeScript(
          buildCodexMcpConfigScript(path, config.content),
          "MCP_WRITE",
        ),
      ];
};

const renderMcpConfig = (
  agent: Agent,
  codePlan: CodePlan,
  home: string,
): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites);
  const scripts = buildMcpConfigScripts(config, home);
  return [
    `mkdir -p ${quote([dirname(expandHome(config.path, home))])}`,
    ...scripts.flatMap(renderNodeScript),
  ];
};

const renderMcpExcluded = (codePlan: CodePlan): string[] =>
  codePlan.excluded.map(
    (server) =>
      `echo ${quote([`[sandhop] mcp skipped: ${server.name} (${server.reason})`])}`,
  );

const renderMcpCode = (codePlan: CodePlan): string[] => {
  const runtimes = [
    ...(codePlan.runtimes.has("bun")
      ? ["curl -fsSL https://bun.sh/install | bash"]
      : []),
    ...(codePlan.runtimes.has("uv")
      ? ["curl -LsSf https://astral.sh/uv/install.sh | sh"]
      : []),
  ];
  return [
    ...runtimes,
    ...(runtimes.length === 0
      ? []
      : ['export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"']),
    ...codePlan.installCmds,
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

export const uploadEnrichmentScripts = async (
  sandbox: Sandbox,
  agent: Agent,
  codePlan: CodePlan,
  home: string,
): Promise<void> => {
  if (codePlan.rewrites.length === 0) return;
  await uploadOwnedFiles(
    sandbox,
    buildMcpConfigScripts(agent.formatMcpConfig(codePlan.rewrites), home),
    [],
  );
};

export const renderEnrichmentSetup = (): string =>
  ["set -e", ZSTD_INSTALL].join("\n");

export const renderEnrichmentConfig = (
  agent: Agent,
  codePlan: CodePlan,
  home: string,
): string => {
  const excluded = renderMcpExcluded(codePlan);
  const config = renderMcpConfig(agent, codePlan, home);
  if (config.length === 0)
    return ["set -e", ...excluded, 'echo "[sandhop] mcp config skipped"'].join(
      "\n",
    );
  return ["set -e", ...excluded, ...config].join("\n");
};

export const renderEnrichmentInstalls = (codePlan: CodePlan): string =>
  ["set -e", ZSTD_INSTALL, ...renderMcpCode(codePlan)].join("\n");

export const renderSettingsScriptInstalls = (
  plan: ScriptCapturePlan,
): string => {
  if (plan.installCmds.length === 0)
    return 'echo "[sandhop] settings script installs skipped"';
  return plan.installCmds.join("\n");
};

export const renderReinstall = (commands: string[]): string => {
  if (commands.length === 0) return 'echo "[sandhop] reinstall skipped"';
  return [
    "export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1",
    ...commands.map(
      (command) =>
        `timeout ${REINSTALL_CMD_TIMEOUT_SECONDS} sh -lc ${quote([command])}`,
    ),
  ].join("\n");
};

export const renderEnrichmentCompletion = (
  steps: EnrichmentStepResult[],
): string =>
  [...renderSummary(steps), "touch /tmp/sandhop-enriched"].join("\n");
