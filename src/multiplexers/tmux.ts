import type { Multiplexer, TerminalGrid } from "../core/ports/multiplexer.js";
import type { CommandInvocation } from "../core/ports/provider.js";

export class TmuxMultiplexer implements Multiplexer {
  readonly id = "tmux";

  install(grid: TerminalGrid): string[] {
    return [
      "command -v tmux",
      `printf '%s\\n' 'set -g status off' 'set -g window-size latest' 'set -g default-size ${grid.cols}x${grid.rows}' 'set -g focus-events on' > "$HOME/.tmux.conf"`,
    ];
  }

  attach(session: string, command: CommandInvocation): CommandInvocation {
    return {
      file: "tmux",
      args: ["-u", "new", "-A", "-s", session, command.file, ...command.args],
    };
  }
}
