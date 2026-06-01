import { safeRemoteProj } from "./encode.js";
import type { AgentId } from "./ports/agent.js";

export interface Manifest {
  agent: AgentId;
  cliVersion: string;
  originalCwd: string;
  remoteProj: string;
  remoteEnc: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}

export const buildManifest = (args: {
  agent: AgentId;
  cliVersion: string;
  originalCwd: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}): Manifest => {
  const { dir, enc } = safeRemoteProj(args.originalCwd);
  return {
    agent: args.agent,
    cliVersion: args.cliVersion,
    originalCwd: args.originalCwd,
    remoteProj: dir,
    remoteEnc: enc,
    sessionId: args.sessionId,
    transcriptName: args.transcriptName,
    ts: args.ts,
  };
};
