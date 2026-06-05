import type { Multiplexer } from "../core/ports/multiplexer.js";

export class TmuxMultiplexer implements Multiplexer {
  readonly id = "tmux";

  install(): string[] {
    return [
      `$SUDO bash -lc 'DEBIAN_FRONTEND=noninteractive apt-get install -y tmux'`,
      `printf '%s\\n' 'set -g status off' 'set -g window-size latest' > "$HOME/.tmux.conf"`,
    ];
  }

  attach(session: string, command: string): string {
    return `tmux new -A -s ${session} ${command}`;
  }
}
