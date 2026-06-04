import type { HostDeps } from "../ports/host.js";

export interface SnapshotBuilder {
  build(cwd: string): Promise<string>;
}

export class SnapshotService implements SnapshotBuilder {
  readonly host: HostDeps;

  constructor(host: HostDeps) {
    this.host = host;
  }

  async build(cwd: string): Promise<string> {
    return this.host.realpath(cwd);
  }
}
