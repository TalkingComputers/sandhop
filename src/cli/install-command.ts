import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { joinPath } from "../core/paths.js";

export type InstalledAgent = "Claude Code" | "Codex";

export const CLAUDE_COMMAND = `---
description: Teleport this Claude Code session to a cloud sandbox (keepon)
allowed-tools: Bash
---

Run \`keepon push\` in the current working directory. Surface the KEEPON_URL and
KEEPON_AUTH from its output prominently so the user can open the web terminal.
`;

export const CODEX_PROMPT = `---
description: Teleport this Codex session to a cloud sandbox (keepon)
---

Run the shell command \`keepon push\` in the current working directory and show me the
resulting KEEPON_URL and KEEPON_AUTH so I can open the web terminal.
`;

export const installCommands = (home: string): InstalledAgent[] => {
  const installed: InstalledAgent[] = [];
  const claudeDir = joinPath(home, ".claude");
  if (existsSync(claudeDir)) {
    const commandsDir = joinPath(claudeDir, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(joinPath(commandsDir, "keepon.md"), CLAUDE_COMMAND);
    installed.push("Claude Code");
  }
  const codexDir = joinPath(home, ".codex");
  if (existsSync(codexDir)) {
    const promptsDir = joinPath(codexDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(joinPath(promptsDir, "keepon.md"), CODEX_PROMPT);
    installed.push("Codex");
  }
  return installed;
};
