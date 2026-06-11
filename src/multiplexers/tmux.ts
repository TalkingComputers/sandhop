import type { Multiplexer } from "../core/ports/multiplexer.js";
import type { CommandInvocation } from "../core/ports/provider.js";

export class TmuxMultiplexer implements Multiplexer {
  readonly id = "tmux";

  install(): string[] {
    return [
      "command -v tmux",
      `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g focus-events on' 'set -g mouse on' 'set -g history-limit 10000' > "$HOME/.tmux.conf"`,
    ];
  }

  attach(session: string, command: CommandInvocation): CommandInvocation {
    return {
      file: "tmux",
      args: ["-u", "new", "-A", "-s", session, command.file, ...command.args],
    };
  }
}
