import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export const detectVersion = (
  host: Pick<HostDeps, "exec">,
  agent: Agent,
): string =>
  agent.parseVersion(host.exec(agent.bin, agent.detectVersionArgs).trim());
