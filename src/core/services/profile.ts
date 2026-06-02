import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";

const CLAUDE_SKILL_SIZE_LIMIT = 5 * 1024 * 1024;

const joinHome = (home: string, path: string): string => `${home}/${path}`;

const readFirstPathSegment = (path: string): string => path.split("/")[0]!;

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
    const entries = [
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/CLAUDE.md",
      ".claude/commands",
      ".claude/plugins/known_marketplaces.json",
      ".claude/plugins/installed_plugins.json",
    ].filter((path) => this.host.exists(joinHome(this.host.home, path)));
    const skillsRoot = joinHome(this.host.home, ".claude/skills");
    if (!this.host.exists(skillsRoot)) return entries;
    const skillNames = [
      ...new Set(
        this.host
          .walk(skillsRoot)
          .map((path) => path.slice(skillsRoot.length + 1))
          .filter((path) => path.length > 0)
          .map(readFirstPathSegment),
      ),
    ].sort();
    for (const name of skillNames) {
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
      entries.push(`.claude/skills/${name}`);
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
