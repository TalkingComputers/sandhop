export const CLAUDE_JSON_PATH = ".claude.json";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CLAUDE_SETTINGS_LOCAL_PATH = ".claude/settings.local.json";
export const CLAUDE_INSTRUCTIONS_PATH = ".claude/CLAUDE.md";
export const CLAUDE_COMMANDS_PATH = ".claude/commands";
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const CLAUDE_AGENTS_PATH = ".claude/agents";
export const CLAUDE_OUTPUT_STYLES_PATH = ".claude/output-styles";
export const CLAUDE_MCP_PATH = ".claude/mcp.json";
export const CLAUDE_PLUGINS_PATH = ".claude/plugins";
export const CLAUDE_PROJECTS_PATH = ".claude/projects";
export const CLAUDE_KNOWN_MARKETPLACES_PATH =
  ".claude/plugins/known_marketplaces.json";
export const CLAUDE_INSTALLED_PLUGINS_PATH =
  ".claude/plugins/installed_plugins.json";
export const CLAUDE_JSON_HOME_PATH = "$HOME/.claude.json";

export const CLAUDE_PROFILE_PATHS = [
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_INSTRUCTIONS_PATH,
  CLAUDE_COMMANDS_PATH,
  CLAUDE_SKILLS_PATH,
  CLAUDE_AGENTS_PATH,
  CLAUDE_OUTPUT_STYLES_PATH,
  CLAUDE_MCP_PATH,
  CLAUDE_PLUGINS_PATH,
];

export const CLAUDE_PROFILE_MANIFEST_PATHS = [
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_INSTRUCTIONS_PATH,
  CLAUDE_COMMANDS_PATH,
  CLAUDE_KNOWN_MARKETPLACES_PATH,
  CLAUDE_INSTALLED_PLUGINS_PATH,
];

export const joinClaudeHomePath = (relativePath: string): string =>
  `$HOME/${relativePath}`;

export const joinClaudeLocalPath = (
  localHome: string,
  relativePath: string,
): string => `${localHome}/${relativePath}`;
