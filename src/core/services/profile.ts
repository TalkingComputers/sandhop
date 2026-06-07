import {
  CLAUDE_PROFILE_MANIFEST_PATHS,
  CLAUDE_SKILLS_PATH,
  joinClaudeLocalPath,
} from "../../agents/claude-paths.js";
import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { dirname, listSkillNames } from "../paths.js";
import { readGitSkillState } from "./git-skill.js";
import { maybeRealpath } from "./mcp-paths.js";

const joinHome = (home: string, path: string): string => `${home}/${path}`;

interface ExternalSkill {
  name: string;
  realDir: string;
}

const isInsideDir = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

const listGitSkillDirs = (host: HostDeps, skillsRoot: string): string[] =>
  listSkillNames(host, skillsRoot)
    .map((name) => `${skillsRoot}/${name}`)
    .filter(
      (skillDir) =>
        !host.isSymlink(skillDir) && host.exists(`${skillDir}/.git`),
    );

const symlinkRealDir = (host: HostDeps, skillDir: string): string | null => {
  if (host.isSymlink(skillDir)) {
    const realPath = maybeRealpath(host, skillDir);
    if (realPath === null) return null;
    return host.isDirectory(realPath) ? realPath : dirname(realPath);
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (!host.exists(skillFile) || !host.isSymlink(skillFile)) return null;
  const realPath = maybeRealpath(host, skillFile);
  return realPath === null ? null : dirname(realPath);
};

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
      if (this.host.exists(`${skillDir}/.git`)) {
        if (readGitSkillState(this.host, skillDir).copyRequired)
          entries.push(`${CLAUDE_SKILLS_PATH}/${name}`);
        continue;
      }
      entries.push(`${CLAUDE_SKILLS_PATH}/${name}`);
    }
    return entries;
  }

  listExternalSymlinkSkills(): ExternalSkill[] {
    const skillsRoot = joinClaudeLocalPath(this.host.home, CLAUDE_SKILLS_PATH);
    const gitSkillDirs = listGitSkillDirs(this.host, skillsRoot);
    const skills: ExternalSkill[] = [];
    for (const name of listSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      const realDir = symlinkRealDir(this.host, skillDir);
      if (realDir === null) continue;
      if (gitSkillDirs.some((gitDir) => isInsideDir(realDir, gitDir))) continue;
      if (!this.host.exists(`${realDir}/SKILL.md`)) continue;
      skills.push({ name, realDir });
    }
    return skills;
  }

  listProfileEntries(): string[] {
    if (this.agent.id === "claude-code") return this.listClaudeProfileEntries();
    const profilePaths = this.agent.profilePaths;
    if (profilePaths === undefined)
      throw new Error(
        `Agent ${this.agent.id} profile paths are not configured`,
      );
    return profilePaths(this.host.home).filter((path) =>
      this.host.exists(joinHome(this.host.home, path)),
    );
  }

  async build(outPath: string, excludes: string[]): Promise<string | null> {
    const entries = this.listProfileEntries();
    const externalSkills =
      this.agent.id === "claude-code" ? this.listExternalSymlinkSkills() : [];
    if (entries.length === 0 && externalSkills.length === 0) return null;
    if (entries.length > 0)
      await this.host.copyTree(this.host.home, entries, outPath, { excludes });
    for (const skill of externalSkills)
      await this.host.copyTree(
        skill.realDir,
        ["."],
        `${outPath}/${CLAUDE_SKILLS_PATH}/${skill.name}`,
        { excludes },
      );
    return outPath;
  }
}
