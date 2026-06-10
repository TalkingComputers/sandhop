import { collectEnvRefs } from "../core/env.js";
import { isRecord, readJsonRecord } from "../core/json.js";
import { listSkillNames, uniqueSorted } from "../core/paths.js";
import type { AgentProfileDeps, ExternalSkill } from "../core/ports/agent.js";
import { readGitSkillState } from "../core/services/git-skill.js";
import { readDisabledPlugins } from "../core/services/reinstall-manifests.js";
import {
  CLAUDE_INSTALLED_PLUGINS_PATH,
  CLAUDE_PROFILE_MANIFEST_PATHS,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILLS_PATH,
  joinClaudeLocalPath,
} from "./claude-paths.js";
import {
  collectSkillDirEnvRefs,
  listPlainSkillDirs,
  listSymlinkSkills,
} from "./skills.js";

const addJsonEnvRefs = (refs: Set<string>, value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) addJsonEnvRefs(refs, item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "env" && isRecord(child)) {
      for (const name of Object.keys(child)) refs.add(name);
    }
    addJsonEnvRefs(refs, child);
  }
};

export const readJsonEnvRefs = (text: string): string[] => {
  const refs = new Set<string>();
  for (const name of collectEnvRefs(text)) refs.add(name);
  try {
    addJsonEnvRefs(refs, JSON.parse(text) as unknown);
  } catch {
    return [...refs].sort();
  }
  return [...refs].sort();
};

const isInsideDir = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

const listGitSkillDirs = (
  deps: AgentProfileDeps,
  skillsRoot: string,
): string[] =>
  listSkillNames(deps, skillsRoot)
    .map((name) => `${skillsRoot}/${name}`)
    .filter(
      (skillDir) =>
        !deps.isSymlink(skillDir) && deps.exists(`${skillDir}/.git`),
    );

export const listClaudeProfileEntries = (deps: AgentProfileDeps): string[] => {
  const entries = CLAUDE_PROFILE_MANIFEST_PATHS.filter((path) =>
    deps.exists(`${deps.home}/${path}`),
  );
  const skillsRoot = joinClaudeLocalPath(deps.home, CLAUDE_SKILLS_PATH);
  for (const skill of listPlainSkillDirs(deps, skillsRoot)) {
    if (deps.exists(`${skill.dir}/.git`)) {
      if (readGitSkillState(deps, skill.dir).copyRequired)
        entries.push(`${CLAUDE_SKILLS_PATH}/${skill.name}`);
      continue;
    }
    entries.push(`${CLAUDE_SKILLS_PATH}/${skill.name}`);
  }
  return entries;
};

export const listExternalSymlinkSkills = (
  deps: AgentProfileDeps,
): ExternalSkill[] => {
  const skillsRoot = joinClaudeLocalPath(deps.home, CLAUDE_SKILLS_PATH);
  const gitSkillDirs = listGitSkillDirs(deps, skillsRoot);
  return listSymlinkSkills(deps, skillsRoot, CLAUDE_SKILLS_PATH, (realDir) =>
    gitSkillDirs.some((gitDir) => isInsideDir(realDir, gitDir)),
  );
};

const readDisabledPluginSet = (deps: AgentProfileDeps): Set<string> => {
  const path = joinClaudeLocalPath(deps.home, CLAUDE_SETTINGS_PATH);
  const settings = readJsonRecord(deps, path);
  if (settings === null) return new Set();
  return new Set(readDisabledPlugins(path, settings));
};

const addPluginEnvRefs = (deps: AgentProfileDeps, refs: Set<string>): void => {
  const installed = readJsonRecord(
    deps,
    joinClaudeLocalPath(deps.home, CLAUDE_INSTALLED_PLUGINS_PATH),
  );
  const plugins = installed?.plugins;
  if (!isRecord(plugins)) return;
  const disabled = readDisabledPluginSet(deps);
  for (const [name, installs] of Object.entries(plugins)) {
    if (disabled.has(name) || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (!isRecord(install)) continue;
      const installPath = install.installPath;
      if (typeof installPath !== "string") continue;
      const text = deps.readFile(`${installPath}/.mcp.json`);
      if (text === null) continue;
      for (const ref of readJsonEnvRefs(text)) refs.add(ref);
    }
  }
};

export const collectClaudeExtraEnvRefs = (deps: AgentProfileDeps): string[] => {
  const refs = new Set<string>();
  addPluginEnvRefs(deps, refs);
  for (const entry of listClaudeProfileEntries(deps)) {
    if (!entry.startsWith(`${CLAUDE_SKILLS_PATH}/`)) continue;
    collectSkillDirEnvRefs(deps, refs, `${deps.home}/${entry}`);
  }
  for (const skill of listExternalSymlinkSkills(deps))
    collectSkillDirEnvRefs(deps, refs, skill.realDir);
  return uniqueSorted(refs);
};
