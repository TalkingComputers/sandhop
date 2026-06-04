import { projectDirName } from "./encode.js";
import type { AgentId } from "./ports/agent.js";

export interface Manifest {
  agent: AgentId;
  cliVersion: string;
  remoteProj: string;
  remoteEnc: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}

export const buildManifest = (args: {
  agent: AgentId;
  cliVersion: string;
  cwd: string;
  sessionId: string;
  transcriptName: string;
  ts: number;
}): Manifest => {
  return {
    agent: args.agent,
    cliVersion: args.cliVersion,
    remoteProj: args.cwd,
    remoteEnc: projectDirName(args.cwd),
    sessionId: args.sessionId,
    transcriptName: args.transcriptName,
    ts: args.ts,
  };
};
