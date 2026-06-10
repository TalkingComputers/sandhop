import type { HostDeps } from "./host.js";
import type { NodeScript } from "../sandbox-scripts.js";

export type AgentId = "claude-code" | "codex";

export interface SessionRef {
  sessionId: string;
  transcriptPath: string;
  transcriptName: string;
}

export interface AuthBundle {
  envs: Record<string, string>;
  files: { path: string; content: string; mode?: string }[];
}

export type McpTransport = "stdio" | "http" | "sse" | "ws";

interface BaseMcpServer {
  name: string;
  startupTimeoutSec?: number;
  extras?: Record<string, unknown>;
}

export interface StdioMcpServer extends BaseMcpServer {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: never;
  headers?: never;
  bearerTokenEnvVar?: never;
  httpHeaders?: never;
  envHttpHeaders?: never;
}

export interface RemoteMcpServer extends BaseMcpServer {
  transport: Exclude<McpTransport, "stdio">;
  url: string;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}

export type McpServer = StdioMcpServer | RemoteMcpServer;

export type McpConfigWrite =
  | { path: string; content: string; mode: "replace-mcp-section" }
  | { path: string; content: string; mode: "merge-mcp-servers" };

export type AgentHostDeps = Pick<
  HostDeps,
  "env" | "home" | "readFile" | "exists" | "keychain" | "realpath" | "sha256Hex"
>;

export type AgentProfileDeps = Pick<
  HostDeps,
  | "home"
  | "exists"
  | "isDirectory"
  | "isSymlink"
  | "readFile"
  | "readlink"
  | "realpath"
  | "walk"
  | "exec"
>;

export interface ExternalSkill {
  realDir: string;
  homeRelative: string;
}

export type AgentSessionDeps = Pick<
  HostDeps,
  "home" | "readFile" | "walk" | "statMtimeMs"
>;

export type AgentPreSeedDeps = Pick<HostDeps, "home" | "readFile">;

export type AgentMcpDeps = Pick<HostDeps, "home" | "readFile">;

export interface Agent {
  readonly id: AgentId;
  readonly pkg: string;
  readonly bin: string;
  detectVersionArgs: string[];
  parseVersion(output: string): string;
  matchSession(deps: AgentSessionDeps, cwd: string): SessionRef[];
  profileEntries(deps: AgentProfileDeps): string[];
  externalSkills(deps: AgentProfileDeps): ExternalSkill[];
  extraEnvRefs(deps: AgentProfileDeps): string[];
  prepareTranscript(bytes: Uint8Array): Uint8Array;
  mcpConfigPaths(home: string, cwd: string): string[];
  mcpEnvRefs(configText: string): string[];
  parseMcpServers(deps: AgentMcpDeps, cwd: string): McpServer[];
  formatMcpConfig(servers: McpServer[]): McpConfigWrite;
  authEnv(deps: AgentHostDeps): AuthBundle;
  installCmd(version: string): string;
  supportsSettingsScripts(): boolean;
  supportsReinstall(): boolean;
  preSeed(deps: AgentPreSeedDeps, remoteProj: string): NodeScript[];
  remoteTranscriptPath(
    home: string,
    remoteEnc: string,
    transcriptName: string,
  ): string;
  projectMemoryPath(remoteEnc: string): string | null;
  resumeCmd(
    sessionId: string,
    remoteProj: string,
    mcpTimeout: string | undefined,
  ): string;
}
