import type { Agent, McpServer } from "../ports/agent.js";
import type { HostDeps } from "../ports/host.js";
import { uniqueSorted } from "../paths.js";
import {
  type ClassifiedServer,
  type ExcludedServer,
  type LocalServer,
  type McpRuntime,
  addRuntime,
  candidatePaths,
  classify,
  collectReferencedInputs,
  installCmd,
  rewriteServer,
} from "./mcp-classify.js";
import {
  LOCAL_PATH_EXCLUDES,
  type PathMapping,
  nearestRoot,
  sandboxPath,
} from "./mcp-paths.js";

export interface CodePlan {
  mappings: PathMapping[];
  rewrites: McpServer[];
  runtimes: Set<McpRuntime>;
  installCmds: string[];
  referencedFiles: string[];
  envRefs: string[];
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

  plan(cwd: string): CodePlan {
    const servers = this.agent.parseMcpServers(this.host, cwd);
    const mappings: PathMapping[] = [];
    const roots = new Set<string>();
    const runtimes = new Set<McpRuntime>();
    const installCmds: string[] = [];
    const referencedFiles = new Set<string>();
    const envRefs = new Set<string>();
    const excluded: ExcludedServer[] = [];
    const classifications: ClassifiedServer[] = [];
    const rewrites: McpServer[] = [];
    const localServers: LocalServer[] = [];

    for (const server of servers) {
      const referenced = collectReferencedInputs(this.host, server);
      for (const file of referenced.referencedFiles) referencedFiles.add(file);
      for (const ref of referenced.envRefs) envRefs.add(ref);
      const paths = candidatePaths(this.host, server);
      const classification = classify(this.host, server, paths);
      classifications.push({ name: server.name, kind: classification.kind });
      if (classification.kind === "excluded") {
        excluded.push({ name: server.name, reason: classification.reason! });
        continue;
      }
      if (classification.kind === "local-path") {
        const root = nearestRoot(this.host, paths[0]!);
        if (!roots.has(root)) {
          roots.add(root);
          const mapped = sandboxPath(this.host, root);
          mappings.push({ localPath: root, sandboxPath: mapped });
          installCmds.push(...installCmd(this.host, root, mapped));
        }
        addRuntime(this.host, server, paths, root, runtimes);
        localServers.push({ server, paths });
        continue;
      }
      rewrites.push(server);
    }

    const localRewrites = localServers.map((localServer) =>
      rewriteServer(this.host, localServer.server, mappings),
    );

    return {
      mappings,
      rewrites: [...localRewrites, ...rewrites],
      runtimes,
      installCmds,
      referencedFiles: uniqueSorted(referencedFiles),
      envRefs: uniqueSorted(envRefs),
      excluded,
      classifications,
    };
  }

  async build(cwd: string, outPath?: string): Promise<CodePlan | null> {
    const plan = this.plan(cwd);
    if (plan.classifications.length === 0) return null;
    if (outPath !== undefined && plan.mappings.length > 0) {
      const entries = plan.mappings.map((mapping) => {
        if (!mapping.localPath.startsWith(`${this.host.home}/`))
          throw new Error(
            `Cannot package MCP path outside host home: ${mapping.localPath}`,
          );
        return mapping.localPath.slice(this.host.home.length + 1);
      });
      await this.host.tarGz(this.host.home, entries, outPath, {
        excludes: LOCAL_PATH_EXCLUDES,
      });
    }
    return plan;
  }
}
