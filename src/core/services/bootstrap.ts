import type { Manifest } from "../manifest.js";
import type { Agent } from "../ports/agent.js";
import type { CodePlan } from "./mcp-code.js";
import type { ScriptCapturePlan } from "./scripts.js";

export interface BootstrapOptions {
  tailscale?: { sandboxId: string };
}

export interface EnrichmentBootstrapOptions {
  codePlan?: CodePlan | null;
}

export type EnrichmentStepResult =
  | { name: string; ok: true }
  | { name: string; ok: false; error: string };

const ZSTD_INSTALL = "command -v zstd || sudo apt-get install -y zstd";
const LOW_PRIORITY_SETUP =
  'KEEPON_LOW_PRIORITY="nice -n 19"; if command -v ionice >/dev/null 2>&1; then KEEPON_LOW_PRIORITY="nice -n 19 ionice -c3"; fi';

const dirname = (path: string): string => {
  const clean = path.replace(/\/+$/, "");
  const index = clean.lastIndexOf("/");
  if (index <= 0) return "/";
  return clean.slice(0, index);
};

const shellPath = (path: string): string =>
  path.startsWith("$HOME") ? `"${path}"` : path;

const shellLog = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");

const quoteShell = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const nonFatal = (cmd: string): string =>
  `${cmd} || { echo "[keepon] step failed: ${shellLog(cmd)}" >&2; true; }`;

const runLowPriority = (cmd: string): string =>
  `$KEEPON_LOW_PRIORITY sh -lc ${quoteShell(cmd)}`;

const pruneMcpTablesScript = (path: string): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}.replace("$HOME",process.env.HOME)`,
    'const lines=fs.readFileSync(f,"utf8").split(/\\r?\\n/)',
    "const out=[]",
    "let skip=false",
    "for(const line of lines){if(/^\\s*\\[mcp_servers(?:\\.|\\])/.test(line)){skip=true;continue}if(skip&&/^\\s*\\[/.test(line))skip=false;if(!skip)out.push(line)}",
    'fs.writeFileSync(f,out.join("\\n").replace(/\\n*$/,"\\n"))',
  ].join(";");

const mergeClaudeMcpScript = (path: string, content: string): string =>
  [
    'const fs=require("fs")',
    `const f=${JSON.stringify(path)}.replace("$HOME",process.env.HOME)`,
    `const s=JSON.parse(${JSON.stringify(content)})`,
    'const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{}',
    "j.mcpServers=s",
    'fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")',
  ].join(";");

const renderMcpConfig = (
  agent: Agent,
  codePlan: CodePlan,
  remoteProj: string,
): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites, remoteProj);
  const dir = dirname(config.path);
  if (config.mode === "merge-claude-json")
    return [
      `mkdir -p ${shellPath(dir)}`,
      `node -e ${JSON.stringify(mergeClaudeMcpScript(config.path, config.content))}`,
    ];
  const redirect = config.mode === "append" ? ">>" : ">";
  return [
    `mkdir -p ${shellPath(dir)}`,
    ...(config.mode === "append"
      ? [`node -e ${JSON.stringify(pruneMcpTablesScript(config.path))}`]
      : []),
    `cat ${redirect} ${shellPath(config.path)} <<'KEEPON_MCP_CONFIG'`,
    config.content.trimEnd(),
    "KEEPON_MCP_CONFIG",
  ];
};

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
  'echo "[keepon] enrichment summary"',
  ...steps.map((step) =>
    step.ok
      ? `echo "[keepon] ok: ${shellLog(step.name)}"`
      : `echo "[keepon] failed: ${shellLog(step.name)}: ${shellLog(step.error)}"`,
  ),
];

export class BootstrapService {
  readonly agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  render(manifest: Manifest, opts: BootstrapOptions): string {
    const dest = this.agent.remoteTranscriptPath(
      manifest.remoteEnc,
      manifest.transcriptName,
    );
    const tailscale = opts.tailscale
      ? [
          "curl -fsSL https://tailscale.com/install.sh | sh",
          "mkdir -p /tmp/tailscaled",
          "sudo tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1055 --statedir=/tmp/tailscaled &",
          `sudo tailscale up --authkey="$TS_AUTHKEY" --hostname="keepon-${opts.tailscale.sandboxId}" --accept-dns=false`,
        ]
      : [];
    return [
      "set -e",
      "sudo curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd",
      "sudo chmod +x /usr/local/bin/ttyd",
      ...tailscale,
      this.agent.installCmd(manifest.cliVersion),
      ...this.agent.preSeed(manifest.remoteProj),
      `mkdir -p ${manifest.remoteProj}`,
      `tar -xzf /tmp/bundle.tgz -C ${manifest.remoteProj}`,
      `dest="${dest}"`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo KEEPON_RESTORE_OK",
    ].join("\n");
  }

  renderEnrichmentSetup(): string {
    return ["set -e", LOW_PRIORITY_SETUP, ZSTD_INSTALL].join("\n");
  }

  renderEnrichmentConfig(
    remoteProj: string,
    opts: EnrichmentBootstrapOptions,
  ): string {
    if (opts.codePlan === null || opts.codePlan === undefined)
      return 'echo "[keepon] mcp config skipped"';
    const config = renderMcpConfig(this.agent, opts.codePlan, remoteProj);
    if (config.length === 0) return 'echo "[keepon] mcp config skipped"';
    return config.join("\n");
  }

  renderEnrichmentInstalls(opts: EnrichmentBootstrapOptions): string {
    return [
      LOW_PRIORITY_SETUP,
      nonFatal(ZSTD_INSTALL),
      ...renderMcpCode(opts.codePlan),
    ].join("\n");
  }

  renderSettingsScriptInstalls(plan: ScriptCapturePlan | null): string {
    if (plan === null || plan.installCmds.length === 0)
      return 'echo "[keepon] settings script installs skipped"';
    return [
      LOW_PRIORITY_SETUP,
      ...plan.installCmds.map((cmd) => nonFatal(runLowPriority(cmd))),
    ].join("\n");
  }

  renderEnrichmentCompletion(steps: EnrichmentStepResult[]): string {
    return [...renderSummary(steps), "touch /tmp/keepon-enriched"].join("\n");
  }

  renderEnrichment(
    remoteProj: string,
    opts: EnrichmentBootstrapOptions,
  ): string {
    return [
      this.renderEnrichmentInstalls(opts),
      this.renderEnrichmentConfig(remoteProj, opts),
      this.renderEnrichmentCompletion([]),
    ].join("\n");
  }
}
