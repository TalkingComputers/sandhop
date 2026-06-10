import type { TerminalGrid } from "../ports/multiplexer.js";

export const TERMINAL_HTML_PATH = "/tmp/sandhop-terminal.html";

const XTERM_CSS =
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css";
const XTERM_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";
const WEBGL_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js";
const UNICODE11_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.min.js";

export const buildTerminalFrontendHtml = (
  grid: TerminalGrid,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sandhop</title>
<link rel="stylesheet" href="${XTERM_CSS}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #stage { position: relative; width: 100%; height: 100%; }
  #term { position: absolute; top: 0; left: 0; }
  #msg {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #ddd; background: rgba(0,0,0,0.75); font: 16px system-ui, sans-serif;
    cursor: pointer; z-index: 10;
  }
  #msg.hidden { display: none; }
</style>
</head>
<body>
<div id="stage"><div id="term"></div></div>
<div id="msg">Connecting…</div>
<script src="${XTERM_JS}"></script>
<script src="${WEBGL_JS}"></script>
<script src="${UNICODE11_JS}"></script>
<script>
(() => {
  const GRID = { cols: ${grid.cols}, rows: ${grid.rows} };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const termEl = document.getElementById("term");
  const msgEl = document.getElementById("msg");
  const showMsg = (text) => { msgEl.textContent = text; msgEl.classList.remove("hidden"); };
  const hideMsg = () => msgEl.classList.add("hidden");

  const term = new Terminal({
    cols: GRID.cols,
    rows: GRID.rows,
    fontSize: 14,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: "#000000" },
  });
  term.open(termEl);
  try {
    term.loadAddon(new WebglAddon.WebglAddon());
  } catch (e) {
    console.warn("[sandhop] webgl renderer unavailable", e);
  }
  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = "11";
  } catch (e) {
    console.warn("[sandhop] unicode11 unavailable", e);
  }

  const viewport = () => ({
    vw: window.visualViewport ? window.visualViewport.width : window.innerWidth,
    vh: window.visualViewport ? window.visualViewport.height : window.innerHeight,
  });

  const fit = () => {
    for (let i = 0; i < 4; i++) {
      const { vw, vh } = viewport();
      const w = termEl.offsetWidth;
      const h = termEl.offsetHeight;
      if (w === 0 || h === 0) return;
      const scale = Math.min(vw / w, vh / h);
      if (scale >= 0.97 && scale <= 1.0) break;
      const next = Math.max(2, Math.min(18, Math.round(term.options.fontSize * scale * 100) / 100));
      if (Math.abs(next - term.options.fontSize) < 0.05) break;
      term.options.fontSize = next;
    }
    const { vw, vh } = viewport();
    termEl.style.left = Math.max(0, (vw - termEl.offsetWidth) / 2) + "px";
    termEl.style.top = Math.max(0, (vh - termEl.offsetHeight) / 2) + "px";
  };
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

  const fetchToken = async () => {
    const res = await fetch(location.origin + "/token");
    if (!res.ok) throw new Error("token fetch failed: " + res.status);
    return (await res.json()).token;
  };

  let ws = null;
  let inputHooked = false;
  const connect = (token) => {
    const wsUrl = location.origin.replace(/^http/, "ws") + "/ws";
    ws = new WebSocket(wsUrl, ["tty"]);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      hideMsg();
      ws.send(encoder.encode(JSON.stringify({ AuthToken: token, columns: GRID.cols, rows: GRID.rows })));
      term.focus();
      fit();
    };
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
      const cmd = String.fromCharCode(data[0]);
      const rest = data.subarray(1);
      if (cmd === "0") term.write(rest);
      else if (cmd === "1") document.title = decoder.decode(rest);
    };
    ws.onclose = () => showMsg("Disconnected — tap to reconnect");
    ws.onerror = () => showMsg("Connection error — tap to reconnect");
    if (!inputHooked) {
      inputHooked = true;
      term.onData((input) => {
        if (ws === null || ws.readyState !== WebSocket.OPEN) return;
        const bytes = encoder.encode(input);
        const frame = new Uint8Array(bytes.length + 1);
        frame[0] = "0".charCodeAt(0);
        frame.set(bytes, 1);
        ws.send(frame);
      });
    }
  };

  const start = () => {
    showMsg("Connecting…");
    fetchToken().then(connect).catch((e) => showMsg("Auth failed (" + e.message + ") — tap to retry"));
  };
  msgEl.addEventListener("click", () => {
    if (ws === null || ws.readyState === WebSocket.CLOSED) start();
  });
  start();
})();
</script>
</body>
</html>
`;
