import type { Agent } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { isRecord } from "../json.js";
import { dirname, joinPath, normalizePath } from "../paths.js";
import { quoteShellPath, shellQuote } from "../shell.js";

export interface ReinstallPlan {
  commands: string[];
}

interface GitSkill {
  name: string;
  localDir: string;
  remoteDir: string;
}

const readLinkedPath = (path: string, target: string): string =>
  normalizePath(
    target.startsWith("/") ? target : joinPath(dirname(path), target),
  );

const readJsonRecord = (
  host: HostDeps,
  path: string,
): Record<string, unknown> | null => {
  const text = host.readFile(path);
  if (text === null) return null;
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`Expected JSON object at ${path}`);
  return parsed;
};

const readMarketplaceSource = (
  path: string,
  name: string,
  value: unknown,
): string => {
  if (!isRecord(value)) throw new Error(`Expected marketplace object ${name}`);
  const source = value.source;
  if (!isRecord(source)) throw new Error(`Expected marketplace source ${name}`);
  const repo = source.repo;
  if (typeof repo === "string") return repo;
  const url = source.url;
  if (typeof url === "string") return url;
  throw new Error(`Expected marketplace repo or url in ${path} for ${name}`);
};

const readPluginKeys = (path: string, value: unknown): string[] => {
  if (!isRecord(value))
    throw new Error(`Expected installed plugins object at ${path}`);
  const plugins = value.plugins;
  if (!isRecord(plugins)) throw new Error(`Expected plugins map at ${path}`);
  return Object.keys(plugins);
};

const readDisabledPlugins = (path: string, value: unknown): string[] => {
  if (!isRecord(value)) throw new Error(`Expected settings object at ${path}`);
  const enabled = value.enabledPlugins;
  if (enabled === undefined) return [];
  if (!isRecord(enabled))
    throw new Error(`Expected enabledPlugins object at ${path}`);
  return Object.entries(enabled)
    .map(([name, state]) => {
      if (state === false) return name;
      if (state === true) return null;
      throw new Error(`Expected boolean enabledPlugins.${name} at ${path}`);
    })
    .filter((name): name is string => name !== null);
};

const parseOriginUrl = (path: string, text: string): string => {
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.trim().match(/^\[remote "([^"]+)"\]$/);
    if (header) {
      inOrigin = header[1] === "origin";
      continue;
    }
    if (!inOrigin) continue;
    const url = line.trim().match(/^url\s*=\s*(.+)$/)?.[1];
    if (url !== undefined) return url;
  }
  throw new Error(`Expected origin remote url at ${path}`);
};

const readPackedRef = (packedRefs: string, ref: string): string | null => {
  for (const line of packedRefs.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
    const parts = line.split(" ");
    if (parts.length === 2 && parts[1] === ref) return parts[0]!;
  }
  return null;
};

const readGitRef = (host: HostDeps, gitDir: string): string => {
  const head = host.readFile(`${gitDir}/HEAD`);
  if (head === null) throw new Error(`Expected ${gitDir}/HEAD`);
  const trimmed = head.trim();
  if (!trimmed.startsWith("ref: ")) return trimmed;
  const ref = trimmed.slice("ref: ".length).trim();
  const refText = host.readFile(`${gitDir}/${ref}`);
  if (refText !== null) return refText.trim();
  const packedRefs = host.readFile(`${gitDir}/packed-refs`);
  if (packedRefs !== null) {
    const packed = readPackedRef(packedRefs, ref);
    if (packed !== null) return packed;
  }
  throw new Error(`Expected resolved git ref ${ref}`);
};

const readSkillNames = (host: HostDeps, skillsRoot: string): string[] => {
  if (!host.exists(skillsRoot)) return [];
  return [
    ...new Set(
      host
        .walk(skillsRoot)
        .map((path) => path.slice(skillsRoot.length + 1))
        .filter((path) => path.length > 0)
        .map((path) => path.split("/")[0]!),
    ),
  ].sort();
};

const toRemoteSkillPath = (
  localPath: string,
  gitSkills: GitSkill[],
): string | null => {
  for (const skill of gitSkills) {
    if (localPath === skill.localDir) return skill.remoteDir;
    if (localPath.startsWith(`${skill.localDir}/`))
      return `${skill.remoteDir}${localPath.slice(skill.localDir.length)}`;
  }
  return null;
};

const readSymlinkSource = (host: HostDeps, skillDir: string): string | null => {
  if (host.isSymlink(skillDir)) {
    const target = readLinkedPath(skillDir, host.readlink(skillDir));
    return target.endsWith("/SKILL.md") ? target : `${target}/SKILL.md`;
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (host.exists(skillFile) && host.isSymlink(skillFile))
    return readLinkedPath(skillFile, host.readlink(skillFile));
  return null;
};

export class ReinstallService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  listMarketplaceCommands(): string[] {
    const path = `${this.host.home}/.claude/plugins/known_marketplaces.json`;
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return Object.keys(record).map(
      (name) =>
        `claude plugin marketplace add ${readMarketplaceSource(path, name, record[name])}`,
    );
  }

  listPluginCommands(): string[] {
    const path = `${this.host.home}/.claude/plugins/installed_plugins.json`;
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return readPluginKeys(path, record).map(
      (plugin) => `claude plugin install ${plugin} --scope user`,
    );
  }

  listDisableCommands(): string[] {
    const path = `${this.host.home}/.claude/settings.json`;
    const record = readJsonRecord(this.host, path);
    if (record === null) return [];
    return readDisabledPlugins(path, record).map(
      (plugin) => `claude plugin disable ${plugin}`,
    );
  }

  listGitSkillCommands(): { commands: string[]; gitSkills: GitSkill[] } {
    const skillsRoot = `${this.host.home}/.claude/skills`;
    const commands: string[] = [];
    const gitSkills: GitSkill[] = [];
    for (const name of readSkillNames(this.host, skillsRoot)) {
      const localDir = `${skillsRoot}/${name}`;
      if (this.host.isSymlink(localDir)) continue;
      const gitDir = `${localDir}/.git`;
      const configPath = `${gitDir}/config`;
      if (!this.host.exists(configPath)) continue;
      const config = this.host.readFile(configPath);
      if (config === null) throw new Error(`Expected ${configPath}`);
      const remoteDir = `$HOME/.claude/skills/${name}`;
      const url = parseOriginUrl(configPath, config);
      const ref = readGitRef(this.host, gitDir);
      gitSkills.push({ name, localDir, remoteDir });
      const clone = `git clone ${shellQuote(url)} ${quoteShellPath(remoteDir)}`;
      const checkout = `git -C ${quoteShellPath(remoteDir)} checkout ${shellQuote(ref)}`;
      commands.push(`${clone} && ${checkout}`);
    }
    return { commands, gitSkills };
  }

  listSymlinkSkillCommands(gitSkills: GitSkill[]): string[] {
    const skillsRoot = `${this.host.home}/.claude/skills`;
    const commands: string[] = [];
    for (const name of readSkillNames(this.host, skillsRoot)) {
      const skillDir = `${skillsRoot}/${name}`;
      const localSource = readSymlinkSource(this.host, skillDir);
      if (localSource === null) continue;
      const remoteSource = toRemoteSkillPath(localSource, gitSkills);
      if (remoteSource === null) continue;
      const remoteSkillDir = `$HOME/.claude/skills/${name}`;
      const mkdir = `mkdir -p ${quoteShellPath(remoteSkillDir)}`;
      const link = `ln -sf ${quoteShellPath(remoteSource)} ${quoteShellPath(`${remoteSkillDir}/SKILL.md`)}`;
      commands.push(`${mkdir} && ${link}`);
    }
    return commands;
  }

  plan(): ReinstallPlan {
    if (!this.agent.supportsReinstall()) return { commands: [] };
    const gitSkillPlan = this.listGitSkillCommands();
    return {
      commands: [
        ...this.listMarketplaceCommands(),
        ...this.listPluginCommands(),
        ...this.listDisableCommands(),
        ...gitSkillPlan.commands,
        ...this.listSymlinkSkillCommands(gitSkillPlan.gitSkills),
      ],
    };
  }
}
