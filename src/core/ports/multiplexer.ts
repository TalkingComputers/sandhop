export interface Multiplexer {
  readonly id: string;
  install(): string[];
  attach(session: string, command: string): string;
}
