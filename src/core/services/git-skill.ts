import type { HostDeps } from "../ports/host.js";
import { dirname, joinPath } from "../paths.js";
import { maybeRealpath } from "./mcp-paths.js";

export interface GitSkill {
  name: string;
  localDir: string;
  remoteDir: string;
}

export interface GitSkillState {
  copyRequired: boolean;
  ref: string | null;
}

export interface SymlinkSkillSource {
  localPath: string;
  realDir: string;
  isDirectory: boolean;
}

export const readLinkedPath = (path: string, target: string): string =>
  target.startsWith("/")
    ? joinPath("/", target)
    : joinPath(dirname(path), target);

export const readGitHead = (host: HostDeps, localDir: string): string =>
  host.exec("git", ["-C", localDir, "rev-parse", "HEAD"]).trim();

export const readGitSkillState = (
  host: HostDeps,
  localDir: string,
): GitSkillState => {
  if (host.exec("git", ["-C", localDir, "status", "--porcelain"]).trim())
    return { copyRequired: true, ref: null };
  const ref = readGitHead(host, localDir);
  return {
    copyRequired:
      host
        .exec("git", ["-C", localDir, "branch", "-r", "--contains", ref])
        .trim().length === 0,
    ref,
  };
};

export const toRemoteSkillPath = (
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

export const readSymlinkSource = (
  host: HostDeps,
  skillDir: string,
): SymlinkSkillSource | null => {
  if (host.isSymlink(skillDir)) {
    const target = readLinkedPath(skillDir, host.readlink(skillDir));
    const realPath = maybeRealpath(host, skillDir);
    if (realPath === null) return null;
    const isDirectory = host.isDirectory(realPath);
    return {
      localPath: isDirectory
        ? target
        : target.endsWith("/SKILL.md")
          ? target
          : `${target}/SKILL.md`,
      realDir: isDirectory ? realPath : dirname(realPath),
      isDirectory,
    };
  }
  const skillFile = `${skillDir}/SKILL.md`;
  if (host.exists(skillFile) && host.isSymlink(skillFile)) {
    const realPath = maybeRealpath(host, skillFile);
    if (realPath === null) return null;
    return {
      localPath: readLinkedPath(skillFile, host.readlink(skillFile)),
      realDir: dirname(realPath),
      isDirectory: false,
    };
  }
  return null;
};
