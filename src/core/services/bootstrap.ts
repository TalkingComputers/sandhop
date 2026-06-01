import type { Manifest } from "../manifest.js";
import type { Agent } from "../ports/agent.js";

export interface BootstrapOptions {
  hasProfile: boolean;
  tailscale?: { sandboxId: string };
}

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
    const profile = opts.hasProfile
      ? ["mkdir -p $HOME && tar -xzf /tmp/profile.tgz -C $HOME"]
      : [];
    return [
      "set -e",
      "sudo curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd",
      "sudo chmod +x /usr/local/bin/ttyd",
      ...tailscale,
      this.agent.installCmd(manifest.cliVersion),
      ...profile,
      ...this.agent.preSeed(manifest.remoteProj),
      `mkdir -p ${manifest.remoteProj}`,
      `tar -xzf /tmp/bundle.tgz -C ${manifest.remoteProj}`,
      `dest="${dest}"`,
      'mkdir -p "$(dirname "$dest")"',
      'cp /tmp/transcript.jsonl "$dest"',
      "echo KEEPON_RESTORE_OK",
    ].join("\n");
  }
}
