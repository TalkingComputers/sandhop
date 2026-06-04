import type { HostDeps } from "./host.js";

export type AgentId = "claude-code" | "codex";

export interface SessionRef {
  sessionId: string;
  transcriptPath: string;
  transcriptName: string;
}

export interface AuthBundle {
  envs: Record<string, string>;
  files: { path: string; content: string }[];
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export type McpConfigWrite =
  | { path: string; content: string; mode: "append" }
  | { path: string; content: string; mode: "overwrite" }
  | { path: string; content: string; mode: "merge-claude-json" };

export type AgentHostDeps = Pick<
  HostDeps,
  | "env"
  | "home"
  | "readFile"
  | "exists"
  | "keychain"
  | "realpath"
  | "sha256Hex"
  | "exec"
>;

export type AgentSessionDeps = Pick<
  HostDeps,
  "home" | "readFile" | "walk" | "statMtimeMs"
>;

export type AgentMcpDeps = Pick<HostDeps, "home" | "readFile">;

export interface Agent {
  readonly id: AgentId;
  readonly pkg: string;
  readonly bin: string;
  detectVersionArgs: string[];
  parseVersion(output: string): string;
  sessionsRoot(home: string): string;
  matchSession(deps: AgentSessionDeps, cwd: string): SessionRef[];
  profilePaths(home: string): string[];
  mcpConfigPaths(home: string, cwd: string): string[];
  mcpEnvRefs(configText: string): string[];
  parseMcpServers(deps: AgentMcpDeps, cwd: string): McpServer[];
  formatMcpConfig(servers: McpServer[]): McpConfigWrite;
  authEnv(deps: AgentHostDeps): AuthBundle;
  installCmd(version: string): string;
  supportsSettingsScripts(): boolean;
  supportsReinstall(): boolean;
  preSeed(remoteProj: string): string[];
  remoteTranscriptPath(remoteEnc: string, transcriptName: string): string;
  resumeCmd(sessionId: string, remoteProj: string): string;
}
