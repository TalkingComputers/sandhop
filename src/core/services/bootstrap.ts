import type { Manifest } from "../manifest.js";
import type { Agent } from "../ports/agent.js";
import type { Multiplexer } from "../ports/multiplexer.js";
import { quote } from "shell-quote";
import { renderNodeScript, type NodeScript } from "../sandbox-scripts.js";

export interface BootstrapOptions {
  home: string;
  preSeedScripts: readonly NodeScript[];
  transportSteps?: string[];
  gitUserName?: string;
  gitUserEmail?: string;
}

const TTYD_INSTALL = "command -v ttyd";

export const renderRestoreScript = (
  agent: Agent,
  multiplexer: Multiplexer,
  manifest: Manifest,
  opts: BootstrapOptions,
): string => {
  const installCmd = agent.installCmd(manifest.cliVersion);
  const dest = agent.remoteTranscriptPath(
    opts.home,
    manifest.remoteEnc,
    manifest.transcriptName,
  );
  return [
    "set -e",
    TTYD_INSTALL,
    ...multiplexer.install(),
    ...(opts.transportSteps ?? []),
    installCmd,
    ...opts.preSeedScripts.flatMap(renderNodeScript),
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
};
