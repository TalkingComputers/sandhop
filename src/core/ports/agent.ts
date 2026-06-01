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

export type AgentHostDeps = Pick<
  HostDeps,
  "env" | "home" | "readFile" | "keychain" | "exec"
>;

export type AgentSessionDeps = Pick<
  HostDeps,
  "home" | "readFile" | "walk" | "statMtimeMs"
>;

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
  authEnv(deps: AgentHostDeps): AuthBundle;
  installCmd(version: string): string;
  preSeed(remoteProj: string): string[];
  remoteTranscriptPath(remoteEnc: string, transcriptName: string): string;
  resumeCmd(sessionId: string, remoteProj: string): string;
}
