import { safeRemoteProj } from "./encode.js";

export type AgentId = "claude-code" | "codex";

export interface Manifest {
  agent: AgentId;
  originalCwd: string;
  remoteProj: string;
  remoteEnc: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}

export const buildManifest = (args: {
  agent: AgentId;
  originalCwd: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}): Manifest => {
  const { dir, enc } = safeRemoteProj(args.originalCwd);
  return {
    agent: args.agent,
    originalCwd: args.originalCwd,
    remoteProj: dir,
    remoteEnc: enc,
    sessionId: args.sessionId,
    transcriptName: args.transcriptName,
    ts: args.ts,
  };
};
