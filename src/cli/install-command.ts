import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { joinPath } from "../core/paths.js";

export type InstalledAgent = "Claude Code" | "Codex";

export const CLAUDE_COMMAND = readFileSync(
  new URL("../../plugin/commands/sandhop.md", import.meta.url),
  "utf8",
);

export const CODEX_SKILL = readFileSync(
  new URL("../../plugin/skills/sandhop/SKILL.md", import.meta.url),
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
    const skillDir = joinPath(codexDir, "skills", "sandhop");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(joinPath(skillDir, "SKILL.md"), CODEX_SKILL);
    rmSync(joinPath(codexDir, "prompts", "sandhop.md"), { force: true });
    installed.push("Codex");
  }
  return installed;
};
