export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const shellLog = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");

export const quoteHomePath = (path: string): string =>
  path.startsWith("$HOME") ? `"${path}"` : path;

export const quoteShellPath = (value: string): string =>
  `"${shellLog(value)
    .replaceAll("\\$HOME", "$HOME")
    .replaceAll("\\${HOME}", "${HOME}")}"`;

export const SUDO_SETUP =
  'SUDO=""; if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi';

export const SANDHOP_OWNER_SETUP =
  'SANDHOP_OWNER="$(id -u):$(id -g)"; if [ "${SANDHOP_RUNTIME_USER:-}" != "" ]; then SANDHOP_OWNER="$(id -u "$SANDHOP_RUNTIME_USER"):$(id -g "$SANDHOP_RUNTIME_USER")"; fi';

export const nonFatal = (cmd: string): string =>
  `${cmd} || { echo "[sandhop] step failed: ${shellLog(cmd)}" >&2; true; }`;
