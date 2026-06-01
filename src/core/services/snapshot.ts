import type { HostDeps } from "../ports/host.js";

export class SnapshotService {
  readonly host: HostDeps;

  constructor(host: HostDeps) {
    this.host = host;
  }

  async build(cwd: string, outPath: string): Promise<string> {
    await this.host.tarGz(cwd, ["."], outPath);
    return outPath;
  }
}
