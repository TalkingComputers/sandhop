import type { CommandInvocation } from "./provider.js";

export interface Multiplexer {
  readonly id: string;
  install(): string[];
  attach(session: string, command: CommandInvocation): CommandInvocation;
}
