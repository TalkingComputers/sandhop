import { collectEnvRefs } from "../core/env.js";
import { dirname, listSkillNames } from "../core/paths.js";
import type { AgentProfileDeps, ExternalSkill } from "../core/ports/agent.js";
import { maybeRealpath } from "../core/services/mcp-paths.js";

export interface SkillDir {
  name: string;
  dir: string;
}

export const listPlainSkillDirs = (
  deps: AgentProfileDeps,
  skillsRoot: string,
): SkillDir[] =>
  listSkillNames(deps, skillsRoot)
    .map((name) => ({ name, dir: `${skillsRoot}/${name}` }))
    .filter(
      ({ dir }) =>
        !deps.isSymlink(dir) &&
        deps.exists(`${dir}/SKILL.md`) &&
        !deps.isSymlink(`${dir}/SKILL.md`),
    );

export const findSymlinkSkillDir = (
  deps: AgentProfileDeps,
  skillDir: string,
): string | null => {
  if (deps.isSymlink(skillDir)) {
    const realPath = maybeRealpath(deps, skillDir);
    if (realPath === null) return null;
    return deps.isDirectory(realPath) ? realPath : dirname(realPath);
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (!deps.exists(skillFile) || !deps.isSymlink(skillFile)) return null;
  const realPath = maybeRealpath(deps, skillFile);
  return realPath === null ? null : dirname(realPath);
};

export const listSymlinkSkills = (
  deps: AgentProfileDeps,
  skillsRoot: string,
  prefix: string,
  skipRealDir: (realDir: string) => boolean,
): ExternalSkill[] => {
  const skills: ExternalSkill[] = [];
  for (const name of listSkillNames(deps, skillsRoot)) {
    const skillDir = `${skillsRoot}/${name}`;
    const realDir = findSymlinkSkillDir(deps, skillDir);
    if (realDir === null) continue;
    if (skipRealDir(realDir)) continue;
    if (!deps.exists(`${realDir}/SKILL.md`)) continue;
    skills.push({ realDir, homeRelative: `${prefix}/${name}` });
  }
  return skills;
};

export const collectSkillDirEnvRefs = (
  deps: AgentProfileDeps,
  refs: Set<string>,
  dir: string,
): void => {
  const skill = deps.readFile(`${dir}/SKILL.md`);
  if (skill !== null) for (const name of collectEnvRefs(skill)) refs.add(name);
  const scripts = `${dir}/scripts`;
  if (!deps.exists(scripts)) return;
  for (const path of deps.walk(scripts)) {
    const text = deps.readFile(path);
    if (text !== null) for (const name of collectEnvRefs(text)) refs.add(name);
  }
};
