import type { Agent, McpServer } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import {
  type ClassifiedServer,
  type ExcludedServer,
  type LocalServer,
  type McpRuntime,
  addCommandRuntimes,
  addProjectRuntimes,
  candidatePaths,
  classify,
  installCmd,
  resolveServerCommand,
  rewriteServer,
} from "./mcp-classify.js";
import { type PathMapping, gitRoot, sandboxPath } from "./mcp-paths.js";

export interface CodePlan {
  mappings: PathMapping[];
  rewrites: McpServer[];
  runtimes: Set<McpRuntime>;
  installCmds: string[];
  excluded: ExcludedServer[];
  classifications: ClassifiedServer[];
}

export class McpCodeService {
  readonly host: HostDeps;
  readonly agent: Agent;

  constructor(host: HostDeps, agent: Agent) {
    this.host = host;
    this.agent = agent;
  }

  plan(cwd: string, sandboxHome: string): CodePlan {
    const servers = this.agent.parseMcpServers(this.host, cwd);
    const mappings: PathMapping[] = [];
    const roots = new Set<string>();
    const runtimes = new Set<McpRuntime>();
    const installCmds: string[] = [];
    const excluded: ExcludedServer[] = [];
    const classifications: ClassifiedServer[] = [];
    const rewrites: McpServer[] = [];
    const localServers: LocalServer[] = [];

    for (const configured of servers) {
      const resolution = resolveServerCommand(this.host, configured);
      if (resolution.kind === "excluded") {
        classifications.push({ name: configured.name, kind: "excluded" });
        excluded.push({ name: configured.name, reason: resolution.reason });
        continue;
      }
      const server = resolution.server;
      const paths = candidatePaths(this.host, server);
      const classification = classify(this.host, server, paths);
      if (classification.kind === "excluded") {
        classifications.push({ name: server.name, kind: "excluded" });
        excluded.push({ name: server.name, reason: classification.reason });
        continue;
      }
      addCommandRuntimes(server, runtimes);
      if (classification.kind === "local-path") {
        const root = gitRoot(this.host, paths[0]!);
        if (root === null) {
          classifications.push({ name: server.name, kind: "excluded" });
          excluded.push({
            name: server.name,
            reason: `no git project root for local path: ${paths[0]!}`,
          });
          continue;
        }
        classifications.push({ name: server.name, kind: "local-path" });
        if (!roots.has(root)) {
          roots.add(root);
          const mapped = sandboxPath(this.host, sandboxHome, root);
          mappings.push({ localPath: root, sandboxPath: mapped });
          installCmds.push(...installCmd(this.host, root, mapped));
        }
        addProjectRuntimes(this.host, paths, root, runtimes);
        localServers.push({ server, paths });
        continue;
      }
      classifications.push({ name: server.name, kind: classification.kind });
      rewrites.push(server);
    }

    const localRewrites = localServers.map((localServer) =>
      rewriteServer(this.host, localServer.server, sandboxHome, mappings),
    );

    return {
      mappings,
      rewrites: [...localRewrites, ...rewrites],
      runtimes,
      installCmds,
      excluded,
      classifications,
    };
  }
}
