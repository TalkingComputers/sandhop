import { expect, test } from "vitest";
import { buildTerminalFrontendHtml } from "../../../src/core/services/terminal-frontend.js";

test("terminal frontend renders the fixed grid and never resizes the pty", () => {
  const html = buildTerminalFrontendHtml({ cols: 200, rows: 50 });

  expect(html).toContain("cols: 200, rows: 50");
  expect(html).toContain('new WebSocket(wsUrl, ["tty"])');
  expect(html).toContain(
    "AuthToken: token, columns: GRID.cols, rows: GRID.rows",
  );
  expect(html).toContain('fetch(location.origin + "/token")');
  expect(html).toContain("term.options.fontSize = next");
  expect(html).not.toContain("transform");
  expect(html).not.toContain('"1" + JSON.stringify');
  expect(html.match(/RESIZE/g)).toBeNull();
  expect(html).toContain("@xterm/xterm@5.5.0");
});
