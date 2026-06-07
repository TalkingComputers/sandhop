import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { joinPath } from "../core/paths.js";

export type InstalledAgent = "Claude Code" | "Codex";

export const CLAUDE_COMMAND = readFileSync(
  new URL("../../plugin/commands/sandhop.md", import.meta.url),
  "utf8",
);

export const CODEX_PROMPT = readFileSync(
  new URL("../../plugin/prompts/sandhop.md", import.meta.url),
  "utf8",
);

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
