import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export const VERSION = pkg.version;

export const HELP_TEXT = `sandhop ${VERSION} — teleport a live coding session to a cloud sandbox

usage: sandhop <command> [options]

commands:
  push        teleport the current session to a cloud sandbox
  list        list running sandboxes
  kill <id>   destroy a sandbox
  setup       configure a provider

options:
  --provider <e2b|modal|daytona|vercel>
  --agent <claude-code|codex>
  --cwd <path>
  --session <id>
  --tunnel <public|cloudflared>
  --exclude <a,b,c>
  --include <abs,paths>
  -h, --help     show this help
  -v, --version  show the version`;
