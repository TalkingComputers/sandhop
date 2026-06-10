import { basename } from "../paths.js";
import type { HostDeps } from "../ports/host.js";
import type { OwnedDir } from "./sandbox-files.js";

export interface SshFile {
  path: string;
  content: string;
  mode: string;
}

export interface SshBundle {
  files: SshFile[];
  dirs: OwnedDir[];
  hosts: string[];
}

export interface SshCollector {
  collect(cwd: string): SshBundle;
}

interface SshHostConfig {
  token: string;
  hostname: string;
  user: string;
  port: string;
  identityFiles: string[];
}

interface KeyFile {
  base: string;
  privateFile: SshFile;
  publicFile?: SshFile;
}

const emptyBundle = (): SshBundle => ({ files: [], dirs: [], hosts: [] });

const readRemoteUrl = (line: string): string | null => {
  const fields = line.trim().split(/\s+/);
  const value = fields[1];
  return value === undefined ? null : value;
};

const sshToken = (url: string): string | null => {
  if (url.startsWith("ssh://")) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "" ? null : parsed.hostname;
    } catch {
      return null;
    }
  }
  if (url.includes("://")) return null;
  const colon = url.indexOf(":");
  if (colon <= 0) return null;
  const target = url.slice(0, colon);
  if (target.includes("/")) return null;
  const at = target.lastIndexOf("@");
  const token = at < 0 ? target : target.slice(at + 1);
  return token === "" ? null : token;
};

const parseSshConfig = (token: string, text: string): SshHostConfig | null => {
  const values = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (match === null) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!;
    const entries = values.get(key);
    if (entries === undefined) values.set(key, [value]);
    else entries.push(value);
  }
  const hostname = values.get("hostname")?.[0];
  const user = values.get("user")?.[0];
  const port = values.get("port")?.[0];
  const identityFiles = values.get("identityfile");
  if (
    hostname === undefined ||
    user === undefined ||
    port === undefined ||
    identityFiles === undefined
  )
    return null;
  return { token, hostname, user, port, identityFiles };
};

const configBlock = (config: SshHostConfig, bases: string[]): string =>
  [
    `Host ${config.token}`,
    `  HostName ${config.hostname}`,
    `  User ${config.user}`,
    `  Port ${config.port}`,
    ...bases.map((base) => `  IdentityFile ~/.ssh/${base}`),
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking accept-new",
    "  RequestTTY no",
  ].join("\n");

export class GitSshService implements SshCollector {
  readonly host: Pick<HostDeps, "exec" | "readFile" | "exists" | "home">;

  constructor(host: Pick<HostDeps, "exec" | "readFile" | "exists" | "home">) {
    this.host = host;
  }

  collect(cwd: string): SshBundle {
    let remotes: string;
    try {
      remotes = this.host.exec("git", ["-C", cwd, "remote", "-v"]);
    } catch {
      return emptyBundle();
    }
    const tokens = [
      ...new Set(
        remotes
          .split(/\r?\n/)
          .map(readRemoteUrl)
          .filter((url): url is string => url !== null)
          .map(sshToken)
          .filter((token): token is string => token !== null),
      ),
    ];
    const privateFiles = new Map<string, SshFile>();
    const publicFiles = new Map<string, SshFile>();
    const knownHosts: string[] = [];
    const configBlocks: string[] = [];
    const hosts: string[] = [];
    for (const token of tokens) {
      const config = this.readConfig(token);
      if (config === null) continue;
      const keys = this.readKeys(config.identityFiles);
      if (keys.length === 0) continue;
      for (const key of keys) {
        if (!privateFiles.has(key.base))
          privateFiles.set(key.base, key.privateFile);
        if (key.publicFile !== undefined) {
          if (!publicFiles.has(key.base))
            publicFiles.set(key.base, key.publicFile);
        }
      }
      const scan = this.readKnownHosts(config);
      if (scan !== null) knownHosts.push(scan);
      hosts.push(token);
      configBlocks.push(
        configBlock(
          config,
          keys.map((key) => key.base),
        ),
      );
    }
    if (privateFiles.size === 0) return emptyBundle();
    const files = [...privateFiles.values(), ...publicFiles.values()];
    if (knownHosts.length > 0)
      files.push({
        path: "$HOME/.ssh/known_hosts",
        content: `${knownHosts.join("\n")}\n`,
        mode: "644",
      });
    files.push({
      path: "$HOME/.ssh/config",
      content: `${configBlocks.join("\n")}\n`,
      mode: "600",
    });
    return { files, dirs: [{ path: "$HOME/.ssh", mode: "700" }], hosts };
  }

  private readConfig(token: string): SshHostConfig | null {
    try {
      return parseSshConfig(token, this.host.exec("ssh", ["-T", "-G", token]));
    } catch {
      return null;
    }
  }

  private readKeys(identityFiles: string[]): KeyFile[] {
    const keys = new Map<string, KeyFile>();
    for (const identityFile of identityFiles) {
      const path = identityFile.replace(/^~(?=\/|$)/, this.host.home);
      if (!this.host.exists(path)) continue;
      const content = this.host.readFile(path);
      if (content === null) continue;
      const base = basename(path);
      if (keys.has(base)) continue;
      const pubPath = `${path}.pub`;
      const pubContent = this.host.exists(pubPath)
        ? this.host.readFile(pubPath)
        : null;
      const key: KeyFile = {
        base,
        privateFile: { path: `$HOME/.ssh/${base}`, content, mode: "600" },
      };
      if (pubContent !== null)
        key.publicFile = {
          path: `$HOME/.ssh/${base}.pub`,
          content: pubContent,
          mode: "644",
        };
      keys.set(base, key);
    }
    return [...keys.values()];
  }

  private readKnownHosts(config: SshHostConfig): string | null {
    try {
      const text = this.host
        .exec("ssh-keyscan", ["-p", config.port, config.hostname])
        .trim();
      return text.length === 0 ? null : text;
    } catch {
      return null;
    }
  }
}
