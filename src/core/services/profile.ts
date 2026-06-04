import {
  CLAUDE_PROFILE_MANIFEST_PATHS,
  CLAUDE_SKILLS_PATH,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { listSkillNames } from "../paths.js";

const CLAUDE_SKILL_SIZE_LIMIT = 5 * 1024 * 1024;

const joinHome = (home: string, path: string): string => `${home}/${path}`;

const hasPathSegment = (path: string, segment: string): boolean =>
  path.split("/").includes(segment);

export class ProfileService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  listClaudeProfileEntries(): string[] {
    const entries = CLAUDE_PROFILE_MANIFEST_PATHS.filter((path) =>
      this.host.exists(joinHome(this.host.home, path)),
    );
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(skillDir)) continue;
      if (!this.host.exists(`${skillDir}/SKILL.md`)) continue;
      if (this.host.isSymlink(`${skillDir}/SKILL.md`)) continue;
      if (this.host.exists(`${skillDir}/.git`)) continue;
      if (
        this.host
          .walk(skillDir)
          .some((path) =>
            hasPathSegment(path.slice(skillDir.length + 1), "node_modules"),
          )
      )
        continue;
      if (this.host.dirSizeBytes(skillDir) >= CLAUDE_SKILL_SIZE_LIMIT) continue;
      entries.push(`${CLAUDE_SKILLS_PATH}/${name}`);
    }
    return entries;
  }

  listProfileEntries(): string[] {
    if (this.agent.id === "claude-code") return this.listClaudeProfileEntries();
    return this.agent
      .profilePaths(this.host.home)
      .filter((path) => this.host.exists(joinHome(this.host.home, path)));
  }

  async build(outPath: string): Promise<string | null> {
    const entries = this.listProfileEntries();
    if (entries.length === 0) return null;
    await this.host.copyTree(this.host.home, entries, outPath);
    return outPath;
  }
}
