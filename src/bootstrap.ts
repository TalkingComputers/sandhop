import type { Adapter } from "./adapters.js";
import type { Manifest } from "./manifest.js";

export interface BootstrapOptions {
  hasProfile: boolean;
  tailscale?: { sandboxId: string };
}

export const renderBootstrap = (
  m: Manifest,
  a: Adapter,
  opts: BootstrapOptions,
): string => {
  const dest = a.remoteTranscriptPath(m.remoteEnc, m.transcriptName);
  const tailscale = opts.tailscale
    ? [
        "curl -fsSL https://tailscale.com/install.sh | sh",
        "mkdir -p /tmp/tailscaled",
        "sudo tailscaled --tun=userspace-networking --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1055 --statedir=/tmp/tailscaled &",
        `sudo tailscale up --authkey="$TS_AUTHKEY" --hostname="keepon-${opts.tailscale.sandboxId}" --accept-dns=false`,
      ]
    : [];
  const profile = opts.hasProfile
    ? [
        "mkdir -p $HOME && tar -xzf /tmp/profile.tgz -C $HOME",
        'if [ -d "$HOME/.env.d" ]; then chmod 700 "$HOME/.env.d"; for f in "$HOME"/.env.d/*; do [ -e "$f" ] || continue; chmod 600 "$f"; done; fi',
      ]
    : [];
  return [
    "set -e",
    "sudo curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd",
    "sudo chmod +x /usr/local/bin/ttyd",
    ...tailscale,
    a.installCmd(m.cliVersion),
    ...profile,
    ...a.preSeed(m.remoteProj),
    `mkdir -p ${m.remoteProj}`,
    `tar -xzf /tmp/bundle.tgz -C ${m.remoteProj}`,
    `dest="${dest}"`,
    'mkdir -p "$(dirname "$dest")"',
    'cp /tmp/transcript.jsonl "$dest"',
    "echo KEEPON_RESTORE_OK",
  ].join("\n");
};
