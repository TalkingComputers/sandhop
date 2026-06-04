import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { joinPath } from "../core/paths.js";

export type InstalledAgent = "Claude Code" | "Codex";

export const CLAUDE_COMMAND = `---
description: Teleport this Claude Code session to a cloud sandbox (sandhop)
allowed-tools: Bash
---

Run \`sandhop push\` in the current working directory. Surface the SANDHOP_URL and
SANDHOP_AUTH from its output prominently so the user can open the web terminal.
`;

export const CODEX_PROMPT = `---
description: Teleport this Codex session to a cloud sandbox (sandhop)
---

Run the shell command \`sandhop push\` in the current working directory and show me the
resulting SANDHOP_URL and SANDHOP_AUTH so I can open the web terminal.
`;

export const installCommands = (home: string): InstalledAgent[] => {
  const installed: InstalledAgent[] = [];
  const claudeDir = joinPath(home, ".claude");
  if (existsSync(claudeDir)) {
    const commandsDir = joinPath(claudeDir, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(joinPath(commandsDir, "sandhop.md"), CLAUDE_COMMAND);
    installed.push("Claude Code");
  }
  const codexDir = joinPath(home, ".codex");
  if (existsSync(codexDir)) {
    const promptsDir = joinPath(codexDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(joinPath(promptsDir, "sandhop.md"), CODEX_PROMPT);
    installed.push("Codex");
  }
  return installed;
};
