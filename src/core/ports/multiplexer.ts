import type { CommandInvocation } from "./provider.js";

export interface TerminalGrid {
  cols: number;
  rows: number;
}

export interface Multiplexer {
  readonly id: string;
  install(grid: TerminalGrid): string[];
  attach(session: string, command: CommandInvocation): CommandInvocation;
}
