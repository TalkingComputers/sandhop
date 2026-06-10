import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

export class ProfileService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  async build(outPath: string, excludes: string[]): Promise<string | null> {
    const entries = this.agent.profileEntries(this.host);
    const skills = this.agent.externalSkills(this.host);
    if (entries.length === 0 && skills.length === 0) return null;
    if (entries.length > 0)
      await this.host.copyTree(this.host.home, entries, outPath, { excludes });
    for (const skill of skills)
      await this.host.copyTree(
        skill.realDir,
        ["."],
        `${outPath}/${skill.homeRelative}`,
        { excludes },
      );
    return outPath;
  }
}
