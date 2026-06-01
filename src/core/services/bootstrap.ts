import type { Manifest } from "../manifest.js";
import type { Agent } from "../ports/agent.js";
import type { CodePlan } from "./mcp-code.js";

export interface BootstrapOptions {
  tailscale?: { sandboxId: string };
}

export interface EnrichmentBootstrapOptions {
  codePlan?: CodePlan | null;
}

const ZSTD_INSTALL = "command -v zstd || sudo apt-get install -y zstd";

const dirname = (path: string): string => {
  const clean = path.replace(/\/+$/, "");
  const index = clean.lastIndexOf("/");
  if (index <= 0) return "/";
  return clean.slice(0, index);
};

const shellPath = (path: string): string =>
  path.startsWith("$HOME") ? `"${path}"` : path;

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

const renderMcpConfig = (
  agent: Agent,
  codePlan: CodePlan,
  remoteProj: string,
): string[] => {
  if (codePlan.rewrites.length === 0) return [];
  const config = agent.formatMcpConfig(codePlan.rewrites, remoteProj);
  const redirect = config.append ? ">>" : ">";
  const dir = dirname(config.path);
  return [
    `mkdir -p ${shellPath(dir)}`,
    ...(config.append
      ? [`node -e ${JSON.stringify(pruneMcpTablesScript(config.path))}`]
      : []),
    `cat ${redirect} ${shellPath(config.path)} <<'KEEPON_MCP_CONFIG'`,
    config.content.trimEnd(),
    "KEEPON_MCP_CONFIG",
  ];
};

const renderMcpCode = (
  agent: Agent,
  codePlan: CodePlan | null | undefined,
  remoteProj: string,
): string[] => {
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
    ...runtimes,
    ...(runtimes.length === 0
      ? []
      : ['export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"']),
    ...codePlan.installCmds,
    ...renderMcpConfig(agent, codePlan, remoteProj),
  ];
};

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
      `dest="${dest}"`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo KEEPON_RESTORE_OK",
    ].join("\n");
  }

  renderEnrichmentSetup(): string {
    return ["set -e", ZSTD_INSTALL].join("\n");
  }

  renderEnrichment(
    remoteProj: string,
    opts: EnrichmentBootstrapOptions,
  ): string {
    return [
      "set -e",
      ZSTD_INSTALL,
      ...renderMcpCode(this.agent, opts.codePlan, remoteProj),
      "touch /tmp/keepon-enriched",
    ].join("\n");
  }
}
