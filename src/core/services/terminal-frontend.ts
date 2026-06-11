export const TERMINAL_HTML_PATH = "/tmp/sandhop-terminal.html";

const XTERM_CSS =
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css";
const XTERM_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";
const FIT_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js";
const UNICODE11_JS =
  "https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.min.js";

export const buildTerminalFrontendHtml = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sandhop</title>
<link rel="stylesheet" href="${XTERM_CSS}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #pan { position: fixed; inset: 0; overflow: auto; -webkit-overflow-scrolling: touch; display: grid; }
  #term { padding: 6px; width: max-content; height: max-content; margin: auto; }
  #msg {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #ddd; background: rgba(0,0,0,0.75); font: 16px system-ui, sans-serif;
    cursor: pointer; z-index: 10;
  }
  #msg.hidden { display: none; }
</style>
</head>
<body>
<div id="pan"><div id="term"></div></div>
<div id="msg">Connecting…</div>
<script src="${XTERM_JS}"></script>
<script src="${FIT_JS}"></script>
<script src="${UNICODE11_JS}"></script>
<script>
(() => {
  const PAD = 12;
  const MIN_FONT = 11;
  const MAX_FONT = 18;
  const BASE_FONT = 14;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const panEl = document.getElementById("pan");
  const termEl = document.getElementById("term");
  const msgEl = document.getElementById("msg");
  const showMsg = (text) => { msgEl.textContent = text; msgEl.classList.remove("hidden"); };
  const hideMsg = () => msgEl.classList.add("hidden");

  // DOM renderer only: the webgl addon silently skips rows at small font
  // sizes (verified against xterm 5.5 + webgl 0.18).
  const term = new Terminal({
    fontSize: BASE_FONT,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: "#000000" },
  });
  try {
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
  } catch (e) {
    console.warn("[sandhop] unicode11 unavailable", e);
  }

  const viewport = () => ({
    vw: window.visualViewport ? window.visualViewport.width : window.innerWidth,
    vh: window.visualViewport ? window.visualViewport.height : window.innerHeight,
  });

  // The pty size is fixed for the whole sandbox lifetime (resizing it would
  // garble already-rendered agent output, which never repaints). The first
  // client sizes the grid to its own screen; every later client renders that
  // same grid, shrunk to fit or panned when it cannot fit readably.
  const fitFont = () => {
    if (window.visualViewport && window.visualViewport.scale > 1.001) return;
    const { vw, vh } = viewport();
    for (let i = 0; i < 6; i++) {
      const w = termEl.offsetWidth;
      const h = termEl.offsetHeight;
      if (w === 0 || h === 0) return;
      const scale = Math.min((vw - PAD) / w, (vh - PAD) / h);
      const next = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, term.options.fontSize * scale)) * 100) / 100;
      if (Math.abs(next - term.options.fontSize) < 0.05) break;
      term.options.fontSize = next;
    }
    panEl.scrollLeft = 0;
    panEl.scrollTop = panEl.scrollHeight;
  };

  let queued = 0;
  const queueFit = () => {
    clearTimeout(queued);
    queued = setTimeout(fitFont, 200);
  };
  window.addEventListener("resize", queueFit);
  window.addEventListener("orientationchange", queueFit);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", queueFit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);

  const fetchJson = async (path) => {
    const res = await fetch(location.origin + path);
    if (!res.ok) throw new Error(path + " failed: " + res.status);
    return res.json();
  };

  const openAt = (size) => {
    if (size !== null) {
      term.resize(size.cols, size.rows);
      term.open(termEl);
    } else {
      term.open(termEl);
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      const { vw, vh } = viewport();
      termEl.style.width = vw - PAD + "px";
      termEl.style.height = vh - PAD + "px";
      fit.fit();
      termEl.style.width = "";
      termEl.style.height = "";
      fit.dispose();
    }
    term.unicode.activeVersion = "11";
    fitFont();
  };

  let ws = null;
  let inputHooked = false;
  const connect = (token) => {
    const wsUrl = location.origin.replace(/^http/, "ws") + "/ws";
    ws = new WebSocket(wsUrl, ["tty"]);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      hideMsg();
      ws.send(encoder.encode(JSON.stringify({ AuthToken: token, columns: term.cols, rows: term.rows })));
      term.focus();
      fitFont();
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

  let opened = false;
  const start = () => {
    showMsg("Connecting…");
    Promise.all([fetchJson("/token"), fetchJson("/size")])
      .then(([auth, size]) => {
        if (!opened) {
          opened = true;
          openAt(size);
        }
        connect(auth.token);
      })
      .catch((e) => showMsg("Auth failed (" + e.message + ") — tap to retry"));
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
