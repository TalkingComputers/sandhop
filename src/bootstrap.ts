import type { Adapter } from "./adapters.js";
import type { Manifest } from "./manifest.js";

export const renderBootstrap = (m: Manifest, a: Adapter): string => {
  const dest = a.remoteTranscriptPath(m.remoteEnc, m.transcriptName);
  return [
    "set -e",
    "sudo curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd",
    "sudo chmod +x /usr/local/bin/ttyd",
    a.installCmd,
    ...a.preSeed(),
    `mkdir -p ${m.remoteProj}`,
    `tar -xzf /tmp/bundle.tgz -C ${m.remoteProj}`,
    `dest="${dest}"`,
    'mkdir -p "$(dirname "$dest")"',
    'cp /tmp/transcript.jsonl "$dest"',
    `sed -i "s#${m.originalCwd}#${m.remoteProj}#g" "$dest" || true`,
    "echo KEEPON_RESTORE_OK",
  ].join("\n");
};
