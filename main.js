// Crave desktop: window, local file server, native ffmpeg, BitTorrent engine, downloads.
const { app, BrowserWindow, protocol, net, ipcMain, session, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const APP_DIR = path.join(__dirname, "app");
const TMP = path.join(os.tmpdir(), "crave-" + process.pid);
const VIDEO_RE = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m2ts|mts|ogv|mpg|mpeg|3gp|mp3|m4a|flac|wav|ogg|opus|aac|torrent)$/i;

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
// Media players start with sound; use the GPU's HEVC decoder where Windows has one.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
// Windows can hand the video to a hardware "overlay" plane that sometimes stops updating after a seek,
// leaving a frozen picture (only frosted-glass areas kept showing the live video). Composite video normally instead.
app.commandLine.appendSwitch("disable-direct-composition-video-overlays");
app.setAppUserModelId("app.crave.player");

let win = null;
let pendingOpen = [];

function fileInfo(p){
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs, url: pathToFileURL(p).href };
  } catch { return null; }
}
// Files or links handed to Crave by Windows ("Open with", double-click, drag onto the icon).
function openArgs(argv){
  const args = argv.slice(app.isPackaged ? 1 : 2).filter(a => a && !a.startsWith("--"));
  const out = [];
  for (const a of args) {
    if (/^(magnet:|https?:\/\/)/i.test(a)) out.push({ link: a });
    else if (VIDEO_RE.test(a) || /\.(srt|vtt|ass|ssa)$/i.test(a)) { const i = fileInfo(path.resolve(a)); if (i) out.push(i); }
  }
  return out;
}
function sendOpen(items){
  if (!items.length) return;
  if (win && !win.webContents.isLoading()) win.webContents.send("open", items);
  else pendingOpen.push(...items);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendOpen(openArgs(argv));
  });
  app.whenReady().then(start);
}

function start(){
  Menu.setApplicationMenu(null);

  // Serve the player from inside the app: app://crave/...
  protocol.handle("app", req => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Screenshot downloads land in Pictures\Crave without a dialog.
  session.defaultSession.on("will-download", (_e, item) => {
    const dir = folderFor("shots");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.parse(item.getFilename());
    let target = path.join(dir, p.base), n = 1;
    while (fs.existsSync(target)) target = path.join(dir, `${p.name} (${n++})${p.ext}`);
    item.setSavePath(target);
    item.once("done", (_ev, state) => { if (state === "completed" && win) win.webContents.send("saved", target); });
  });

  pendingOpen.push(...openArgs(process.argv));
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}

function createWindow(){
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 420, minHeight: 420,
    backgroundColor: (applySavedTheme(), savedTheme() === "light" ? "#eef1f8" : "#0c0b14"), title: "Crave", show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      // A local media player: lets any stream play and be screenshotted regardless of the site's CORS headers.
      webSecurity: false,
      backgroundThrottling: false
    }
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("did-finish-load", () => { if (pendingOpen.length) { win.webContents.send("open", pendingOpen); pendingOpen = []; } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  // Right-click menu: editing for text fields, Copy for selections, and "Play link" anywhere else.
  win.webContents.on("context-menu", async (_e, p) => {
    const { clipboard } = require("electron");
    let clip = "";
    try { clip = String((await clipboard.readText()) || "").trim(); } catch {}   // a promise in newer Electron
    const playable = /^(magnet:|https?:\/\/)\S+$/i.test(clip) || /^[a-f0-9]{40}$/i.test(clip);
    const items = [];
    if (p.isEditable) {
      items.push(
        { label: "Undo", role: "undo", enabled: p.editFlags.canUndo },
        { label: "Redo", role: "redo", enabled: p.editFlags.canRedo },
        { type: "separator" },
        { label: "Cut", role: "cut", enabled: p.editFlags.canCut },
        { label: "Copy", role: "copy", enabled: p.editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: p.editFlags.canPaste },
        { label: "Paste and play", enabled: playable, click: () => win.webContents.send("open", [{ link: clip }]) },
        { type: "separator" },
        { label: "Select all", role: "selectAll" }
      );
    } else {
      if (p.selectionText && p.selectionText.trim()) items.push({ label: "Copy", role: "copy" }, { type: "separator" });
      if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: "Open link in browser", click: () => shell.openExternal(p.linkURL) }, { label: "Copy link", click: () => clipboard.writeText(p.linkURL) }, { type: "separator" });
      items.push({ label: playable ? "Play link from clipboard" : "Play link from clipboard (nothing to play)", enabled: playable, click: () => win.webContents.send("open", [{ link: clip }]) });
    }
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://")) e.preventDefault(); });
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"))) win.webContents.toggleDevTools();
  });
  win.loadURL("app://crave/index.html");
  win.on("closed", () => { win = null; });
}

/* ---------- reading files the page opened by path ---------- */
const fds = new Map();
async function fdFor(p){
  if (fds.has(p)) return fds.get(p);
  const h = await fs.promises.open(p, "r");
  fds.set(p, h);
  if (fds.size > 8) { const [k, old] = fds.entries().next().value; fds.delete(k); old.close().catch(() => {}); }
  return h;
}
ipcMain.handle("read", async (_e, p, a, b) => {
  const h = await fdFor(p);
  const len = Math.max(0, b - a), buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await h.read(buf, 0, len, a);
  return buf.subarray(0, bytesRead);
});
ipcMain.handle("stat-path", (_e, p) => fileInfo(p));
ipcMain.handle("open-shots-folder", () => { const dir = folderFor("shots"); fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });

/* ---------- where screenshots and clips are saved (changeable in Settings) ---------- */
const prefsFile = () => path.join(app.getPath("userData"), "folders.json");
function readFolders(){ try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch { return {}; } }
const defaultFolder = kind => kind === "clips" ? path.join(app.getPath("videos"), "Crave Clips") : path.join(app.getPath("pictures"), "Crave");
function folderFor(kind){
  const f = readFolders()[kind];
  if (f) { try { fs.mkdirSync(f, { recursive: true }); fs.accessSync(f, fs.constants.W_OK); return f; } catch {} }  // gone or read-only → default
  return defaultFolder(kind);
}
ipcMain.handle("folders-get", () => ({ shots: folderFor("shots"), clips: folderFor("clips"), shotsDefault: !readFolders().shots, clipsDefault: !readFolders().clips }));
ipcMain.handle("folder-choose", async (_e, kind) => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog(win, { title: kind === "clips" ? "Choose where clips are saved" : "Choose where screenshots are saved", defaultPath: folderFor(kind), properties: ["openDirectory", "createDirectory", "promptToCreate"] });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = readFolders(); f[kind] = r.filePaths[0];
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true }); fs.writeFileSync(prefsFile(), JSON.stringify(f));
  return folderFor(kind);
});
ipcMain.handle("folder-reset", (_e, kind) => { const f = readFolders(); delete f[kind]; fs.writeFileSync(prefsFile(), JSON.stringify(f)); return folderFor(kind); });
ipcMain.handle("folder-open", (_e, kind) => { const d = folderFor(kind); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

/* ---------- audio conversion with the bundled ffmpeg ---------- */
function ffmpegPath(){
  if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg.exe");
  return process.env.CRAVE_FFMPEG || "ffmpeg";
}
let ffProc = null, ffCancelled = false;
function runFF(args, duration, onProgress){
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    ffProc = p;
    let dur = duration || 0, err = "", out = "";
    p.stderr.on("data", d => {
      err = (err + d).slice(-4000);
      if (!dur) { const m = err.match(/Duration: (\d+):(\d+):([\d.]+)/); if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3]; }
    });
    p.stdout.on("data", d => {
      out += d; const lines = out.split("\n"); out = lines.pop();
      for (const l of lines) {
        const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && dur) onProgress(Math.min(1, +m[1] / 1e6 / dur));
      }
    });
    p.on("error", reject);
    p.on("close", code => { if (ffProc === p) ffProc = null; code === 0 ? resolve() : reject(new Error(ffCancelled ? "cancelled" : (err.trim().split("\n").pop() || "ffmpeg exited with code " + code))); });
  });
}
ipcMain.handle("convert-audio", async (e, { input, track, copy, duration }) => {
  fs.mkdirSync(TMP, { recursive: true });
  ffCancelled = false;
  const modes = (copy ? [["copy", copy]] : []).concat([["aac", "m4a"]]);
  let lastErr;
  for (const [mode, ext] of modes) {
    const out = path.join(TMP, `audio-${Date.now()}-${track}.${ext}`);
    const args = ["-hide_banner", "-nostdin", "-y", ...netIn(input), "-i", input, "-map", `0:a:${track}`, "-vn", "-sn", "-dn"]
      .concat(mode === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k", "-ac", "2"])
      .concat(["-progress", "pipe:1", "-nostats", out]);
    try {
      await runFF(args, duration, p => { if (!e.sender.isDestroyed()) e.sender.send("convert-progress", p); });
      return { url: pathToFileURL(out).href, path: out };
    } catch (err) {
      lastErr = err; try { fs.unlinkSync(out); } catch {}
      if (ffCancelled) throw err;
    }
  }
  throw lastErr;
});
ipcMain.handle("convert-cancel", () => { ffCancelled = true; if (ffProc) ffProc.kill(); });

/* ---------- BitTorrent (TCP/UDP peers, DHT, trackers, web peers) ---------- */
let tclient = null, ttorrent = null, tserver = null;
async function torrentStop(){
  if (tserver) { try { tserver.close(); } catch {} tserver = null; }
  if (ttorrent) { const t = ttorrent; ttorrent = null; await new Promise(r => { try { t.destroy({ destroyStore: true }, () => r()); } catch { r(); } }); }
}
ipcMain.handle("torrent-stop", () => torrentStop());
ipcMain.handle("torrent-add", async (_e, src) => {
  await torrentStop();
  if (!tclient) {
    const WebTorrent = require("webtorrent");
    tclient = new WebTorrent();
    tclient.on("error", err => console.error("torrent client:", err.message));
  }
  const id = src.magnet || (src.path ? fs.readFileSync(src.path) : Buffer.from(src.data));
  return new Promise((resolve, reject) => {
    const t = tclient.add(id, { path: path.join(TMP, "torrents") }, torrent => {
      if (ttorrent !== torrent) return;
      const server = torrent.createServer();
      server.listen(0, "127.0.0.1", () => {
        tserver = server;
        const port = server.address().port;
        resolve({
          name: torrent.name, length: torrent.length,
          files: torrent.files.map((f, i) => ({ index: i, name: f.name, length: f.length, url: `http://127.0.0.1:${port}/${i}/${encodeURIComponent(f.name)}` }))
        });
      });
    });
    ttorrent = t;
    t.once("error", err => reject(new Error(err.message || String(err))));
    // Peers named in the magnet link itself (x.pe=host:port) are dialled directly.
    let hinted = [];
    try { if (src.magnet) hinted = new URL(src.magnet).searchParams.getAll("x.pe"); } catch {}
    if (hinted.length) t.once("infoHash", () => hinted.forEach(p => { try { t.addPeer(p); } catch {} }));
  });
});
ipcMain.handle("torrent-stats", () => {
  const t = ttorrent; if (!t) return null;
  return { numPeers: t.numPeers, downloadSpeed: t.downloadSpeed, progress: t.progress, length: t.length };
});

/* ---------- reading a source's tracks (works for files, links and torrents) ---------- */
function parseProbe(text){
  const res = { duration: 0, video: [], audio: [], subs: [] };
  const dm = text.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (dm) res.duration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
  let last = null;
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]+)\))?: (Video|Audio|Subtitle): ([^,\s]+)(.*)$/);
    if (m) {
      const s = { index: +m[1], lang: m[2] || "und", codec: m[4], title: "", def: /\(default\)/.test(l), forced: /\(forced\)/.test(l), sdh: /\(hearing impaired\)/.test(l) };
      if (m[3] === "Audio") { const ch = l.match(/, (mono|stereo|2\.1|quad|5\.0|5\.1|6\.1|7\.1|\d+ channels)/); s.layout = ch ? ch[1] : ""; res.audio.push(s); }
      else if (m[3] === "Video") {
        if (!/attached pic/.test(l)) {
          const wh = l.match(/, (\d{2,5})x(\d{2,5})/);
          if (wh) { s.w = +wh[1]; s.h = +wh[2]; }
          s.tenbit = /p(10|12)(le|be)?\b/.test(l);
          const fr = l.match(/, ([\d.]+) fps/) || l.match(/, ([\d.]+) tbr/); if (fr) s.fps = +fr[1];
          s.hdr = /smpte2084/.test(l) ? "HDR10" : /arib-std-b67/.test(l) ? "HLG" : "";
          res.video.push(s);
        }
      }
      else res.subs.push(s);
      last = s; continue;
    }
    if (/^\s*Stream #/.test(l)) { last = null; continue; }
    if (/DOVI configuration record/.test(l) && res.video.length) {
      const vs = res.video[res.video.length - 1], pm = l.match(/profile:\s*(\d+)/);
      vs.dvProfile = pm ? +pm[1] : 0;
      vs.hdr = "Dolby Vision" + (vs.hdr === "HDR10" && vs.dvProfile !== 5 ? " / HDR10" : "");
    }
    if (/Mastering Display Metadata|Content Light Level/.test(l) && res.video.length && !res.video[res.video.length - 1].hdr) res.video[res.video.length - 1].hdr = "HDR10";
    const t = l.match(/^\s{4,}title\s*:\s*(.+)$/);
    if (t && last) last.title = t[1].trim();
  }
  return res;
}
/* ---------- network inputs: keep reading through dropped connections and slow servers ---------- */
const NET_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const netIn = input => /^https?:/i.test(String(input || "")) ? ["-user_agent", NET_UA, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_on_http_error", "5xx", "-reconnect_delay_max", "8", "-rw_timeout", "30000000"] : [];
/* ---------- appearance: Windows title bar and window colour follow the app's light/dark choice ---------- */
const themeFile = () => path.join(app.getPath("userData"), "theme.json");
// The Windows title bar follows nativeTheme, so set it from the saved choice before the window appears.
function applySavedTheme(){ try { const m = JSON.parse(fs.readFileSync(themeFile(), "utf8")).mode; require("electron").nativeTheme.themeSource = ["light", "dark", "system"].includes(m) ? m : "dark"; } catch { require("electron").nativeTheme.themeSource = "dark"; } }
function savedTheme(){ try { const m = JSON.parse(fs.readFileSync(themeFile(), "utf8")).mode; if (m === "light" || m === "system") return m === "system" ? (require("electron").nativeTheme.shouldUseDarkColors ? "dark" : "light") : m; } catch {} return "dark"; }
ipcMain.handle("set-theme", (e, m) => {
  const { nativeTheme, BrowserWindow } = require("electron");
  m = ["light", "dark", "system"].includes(m) ? m : "dark";
  nativeTheme.themeSource = m;
  try { fs.writeFileSync(themeFile(), JSON.stringify({ mode: m })); } catch {}
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0c0b14" : "#eef1f8");
});
ipcMain.handle("probe", (_e, input) => new Promise(resolve => {
  const p = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...netIn(input), "-i", input], { windowsHide: true });
  let err = "";
  const kill = setTimeout(() => { try { p.kill(); } catch {} }, 20000);
  p.stderr.on("data", d => { err += d; });
  p.on("error", () => { clearTimeout(kill); resolve(null); });
  p.on("close", () => { clearTimeout(kill); const r = parseProbe(err); resolve(r.video.length || r.audio.length || r.subs.length ? r : null); });
}));

/* ---------- live audio: any codec, converted on the fly from the playback position ---------- */
const astreams = new Map();
function stopAstreams(){ for (const p of astreams.values()) { try { p.kill(); } catch {} } astreams.clear(); }
ipcMain.handle("astream-start", (e, { id, input, track, start, channels = 2, night = false, dialogue = false }) => {
  stopAstreams();
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  // Sound options: keep 5.1 or fold to stereo, lift the centre (dialogue) channel, and even out loud/quiet parts.
  const surround = channels >= 6, af = [];
  af.push(`aformat=channel_layouts=${surround ? "5.1" : "stereo"}`);
  if (dialogue) af.push(surround ? "pan=5.1|FL=FL|FR=FR|FC=1.7*FC|LFE=LFE|BL=BL|BR=BR" : "dialoguenhance=enhance=2.5,aformat=channel_layouts=stereo");
  if (night) af.push("acompressor=threshold=-26dB:ratio=4:attack=5:release=250:makeup=7dB", "alimiter=limit=0.95:level=disabled");
  args.push(...netIn(input), "-i", input, "-map", `0:a:${track}`, "-vn", "-sn", "-dn", "-af", af.join(","),
    "-c:a", "aac", "-b:a", surround ? "384k" : "192k", "-ac", surround ? "6" : "2", "-ar", "48000",
    "-f", "mp4", "-movflags", "+empty_moov+default_base_moof", "-frag_duration", "500000", "pipe:1");
  const p = spawn(ffmpegPath(), args, { windowsHide: true });
  astreams.set(id, p);
  let err = "";
  p.stderr.on("data", d => { err = (err + d).slice(-1500); });
  p.stdout.on("data", d => { if (!e.sender.isDestroyed()) e.sender.send("astream-data", id, d); });
  p.on("error", er => { if (!e.sender.isDestroyed()) e.sender.send("astream-end", id, -1, er.message); });
  p.on("close", code => { astreams.delete(id); if (!e.sender.isDestroyed()) e.sender.send("astream-end", id, code, err.trim().split("\n").pop() || ""); });
});
ipcMain.handle("astream-pause", (_e, id) => { const p = astreams.get(id); if (p) p.stdout.pause(); });
ipcMain.handle("astream-resume", (_e, id) => { const p = astreams.get(id); if (p) p.stdout.resume(); });
ipcMain.handle("astream-stop", () => stopAstreams());

/* ---------- live subtitles: text as WebVTT, picture subtitles (PGS) as raw .sup ---------- */
const sstreams = new Map();
ipcMain.handle("sub-start", (e, { id, input, track, start, dur, format }) => {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-copyts", ...netIn(input), "-i", input);
  if (dur > 0) args.push("-t", dur.toFixed(3));
  args.push("-map", `0:s:${track}`);
  args.push(...(format === "sup" ? ["-c:s", "copy", "-f", "sup"] : ["-c:s", "webvtt", "-f", "webvtt"]), "pipe:1");
  const p = spawn(ffmpegPath(), args, { windowsHide: true });
  sstreams.set(id, p);
  let err = "";
  p.stderr.on("data", d => { err = (err + d).slice(-1500); });
  p.stdout.on("data", d => { if (!e.sender.isDestroyed()) e.sender.send("sub-data", id, d); });
  p.on("error", er => { if (!e.sender.isDestroyed()) e.sender.send("sub-end", id, -1, er.message); });
  p.on("close", code => { sstreams.delete(id); if (!e.sender.isDestroyed()) e.sender.send("sub-end", id, code, err.trim().split("\n").pop() || ""); });
});
ipcMain.handle("sub-stop-all", () => { for (const p of sstreams.values()) { try { p.kill(); } catch {} } sstreams.clear(); });

/* ---------- clips: cut a part of what's playing and save it ---------- */
let clipProc = null, clipCancelled = false;
const clipDir = () => folderFor("clips");
const assColour = hex => "&H00" + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);
function clipName(base, start, end, ext){
  const t = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + "-" : "") + String(m).padStart(h ? 2 : 1, "0") + "-" + String(x).padStart(2, "0"); };
  const clean = String(base || "Clip").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Clip";
  const dir = clipDir(); fs.mkdirSync(dir, { recursive: true });
  let p = path.join(dir, `${clean} ${t(start)} to ${t(end)}.${ext}`), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${clean} ${t(start)} to ${t(end)} (${n++}).${ext}`);
  return p;
}
// Builds the ffmpeg command for one export. Kept separate so it can be retried in a simpler form.
function clipArgs(o, out, { copy, withSubs }){
  const dur = Math.max(0.1, o.end - o.start);
  const lg = o.logo && o.format !== "m4a" && fs.existsSync(logoPath(o.logo.id)) ? o.logo : null;
  // -t comes after every input so it applies to the output, not to the logo
  const a = ["-hide_banner", "-nostdin", "-y", "-ss", o.start.toFixed(3), ...netIn(o.input), "-i", o.input].concat(lg ? ["-i", logoPath(lg.id)] : [], ["-t", dur.toFixed(3)]);
  const audio = o.audioTrack != null && o.audioTrack >= 0 ? `0:a:${o.audioTrack}` : null;
  if (o.format === "m4a") {
    if (!audio) throw new Error("this video has no sound to save");
    return a.concat(["-map", audio, "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "256k"], o.audioLang ? ["-metadata:s:a:0", "language=" + o.audioLang] : [], ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out]);
  }
  // Video filters, in order: HDR → SDR (unless keeping HDR), subtitles, look, size.
  const vf = [];
  const keepHdr = o.hdr && o.keepHdr && o.format === "mp4";
  if (o.hdr && !keepHdr) vf.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p");
  let complex = null;
  if (withSubs && o.sub && o.sub.kind === "text") {
    const st = o.subStyle || {};
    const hex = c => /^#?[0-9a-f]{6}$/i.test(c || "") ? c.replace("#", "") : "ffffff";
    const alpha = op => Math.round((1 - Math.max(0, Math.min(100, op == null ? 60 : op)) / 100) * 255).toString(16).padStart(2, "0").toUpperCase();
    const style = [`FontName=${st.font || "Arial"}`, `FontSize=${st.size || 16}`, `PrimaryColour=${assColour(hex(st.color))}`, `MarginV=${Math.round(288 * (st.pos != null ? st.pos : 7) / 100)}`];
    if (st.bg === "line" || st.bg === "block" || st.bg === "band") {
      // libass draws the box in the outline colour; its alpha is inverted (00 = solid)
      style.push("BorderStyle=3", `OutlineColour=&H${alpha(st.bgOpacity)}${assColour(hex(st.bgColor)).slice(4)}`, "Outline=1.6", "Shadow=0");
    } else if (st.edge === "outline") style.push("BorderStyle=1", "OutlineColour=&H00000000", "Outline=1.4", "Shadow=0");
    else if (st.edge === "none") style.push("BorderStyle=1", "Outline=0", "Shadow=0");
    else style.push("BorderStyle=1", "OutlineColour=&H40000000", "BackColour=&H60000000", "Outline=0.8", "Shadow=0.9");
    vf.push(`subtitles=${o.subFile}:force_style='${style.join(",")}'`);
  }
  if (o.look > 0 && !keepHdr) { const k = o.look; vf.push(`eq=contrast=${(1 + 0.10 * k).toFixed(3)}:saturation=${(1 + 0.28 * k).toFixed(3)}:gamma=${(1 - 0.04 * k).toFixed(3)},unsharp=5:5:${(0.35 * k).toFixed(2)}:5:5:0`); }
  if (o.format === "gif") vf.push(`fps=${o.fps || 15}`, `scale=${o.width || 640}:-2:flags=lanczos`);
  else if (o.height) vf.push(`scale=-2:'min(${o.height},ih)':flags=lanczos`);
  if (withSubs && o.sub && o.sub.kind === "pgs") {
    // Picture subtitles are drawn over the full-size frame, then the rest of the chain runs.
    const pre = o.hdr && !keepHdr ? vf.shift() + "," : "";
    complex = `[0:v:0]${pre ? pre.slice(0, -1) : "null"}[base];[base][0:s:${o.sub.track}]overlay=(W-w)/2:(H-h)/2+H*${((7 - ((o.subStyle && o.subStyle.pos != null) ? o.subStyle.pos : 7)) / 100).toFixed(3)}:eof_action=pass${vf.length ? "," + vf.join(",") : ""}`;
  }
  // The network logo goes on last, at its final pixel size, in the chosen corner.
  if (lg) {
    const base = complex ? complex + "[vpre]" : `[0:v:0]${vf.length ? vf.join(",") : "null"}[vpre]`;
    const m = Math.max(0, Math.round(lg.m || 0)), op = Math.max(0.05, Math.min(1, lg.opacity == null ? 1 : lg.opacity));
    // On an HDR (PQ) picture, plain white would be far too bright: map the logo to HDR reference white (203 nits).
    const pq = keepHdr && o.hdr !== "HLG" ? ",lutrgb=r='PQ':g='PQ':b='PQ'".replace(/PQ/g, "pow((0.8359375+18.8515625*pow(pow(val/255\\,2.2)*0.0203\\,0.1593017578125))/(1+18.6875*pow(pow(val/255\\,2.2)*0.0203\\,0.1593017578125))\\,78.84375)*255") : "";
    const pos = { tl: `x=${m}:y=${m}`, tr: `x=main_w-overlay_w-${m}:y=${m}`, bl: `x=${m}:y=main_h-overlay_h-${m}`, br: `x=main_w-overlay_w-${m}:y=main_h-overlay_h-${m}` }[lg.pos || "tl"];
    complex = `${base};[1:v]format=rgba,scale=${Math.max(8, Math.round(lg.w))}:-1:flags=lanczos,colorchannelmixer=aa=${op.toFixed(3)}${pq}[lg];[vpre][lg]overlay=${pos}:format=auto`;
  }
  if (o.format === "gif") {
    const chain = complex ? complex.replace(/$/, ",split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[out]")
      : `[0:v:0]${vf.join(",")},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[out]`;
    return a.concat(["-filter_complex", chain, "-map", "[out]", "-loop", "0", "-progress", "pipe:1", "-nostats", out]);
  }
  const args = a.slice();
  if (copy) {
    args.push("-map", "0:v:0", "-c:v", "copy");
    if (/hevc|h265/i.test(o.vcodec || "")) args.push("-tag:v", "hvc1");
  } else {
    if (complex) args.push("-filter_complex", complex + "[v]", "-map", "[v]");
    else { args.push("-map", "0:v:0"); if (vf.length) args.push("-vf", vf.join(",")); }
    if (keepHdr) args.push("-c:v", "libx265", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
      "-x265-params", `colorprim=bt2020:transfer=${o.hdr === "HLG" ? "arib-std-b67" : "smpte2084"}:colormatrix=bt2020nc:hdr10=1:log-level=error`);
    else args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  }
  if (audio) { args.push("-map", audio, "-c:a", "aac", "-b:a", "192k", "-ac", "2"); if (o.audioLang) args.push("-metadata:s:a:0", "language=" + o.audioLang); }
  args.push("-sn", "-dn", "-map_metadata", "-1", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out);
  return args;
}
function runClip(args, dur, onProgress){
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true, cwd: TMP });
    clipProc = p;
    let err = "", buf = "";
    p.stderr.on("data", d => { err = (err + d).slice(-3000); });
    p.stdout.on("data", d => {
      buf += d; const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) { const m = l.match(/^out_time_(?:us|ms)=(\d+)/); if (m) onProgress(Math.min(0.99, +m[1] / 1e6 / dur)); }
    });
    p.on("error", reject);
    p.on("close", code => {
      if (clipProc === p) clipProc = null;
      if (code === 0) resolve();
      else reject(new Error(clipCancelled ? "cancelled" : (err.trim().split("\n").filter(x => !/^\s*$/.test(x)).pop() || "ffmpeg stopped with code " + code)));
    });
  });
}
ipcMain.handle("clip-export", async (e, o) => {
  fs.mkdirSync(TMP, { recursive: true });
  clipCancelled = false;
  const ext = o.format === "gif" ? "gif" : o.format === "m4a" ? "m4a" : "mp4";
  const out = clipName(o.name, o.start, o.end, ext);
  const dur = Math.max(0.1, o.end - o.start);
  const send = p => { if (!e.sender.isDestroyed()) e.sender.send("clip-progress", p); };
  if (o.sub && o.sub.kind === "text") {
    o.subFile = `clip-subs-${Date.now()}.srt`;
    fs.writeFileSync(path.join(TMP, o.subFile), o.sub.srt, "utf8");
  }
  // Fast mode copies the picture without re-encoding; it falls back to a full encode if the format won't allow it.
  const attempts = [];
  const canCopy = o.mode === "fast" && o.format === "mp4" && !o.sub && !o.look && !o.height && !o.logo && !(o.hdr && !o.keepHdr);
  if (canCopy) attempts.push({ copy: true, withSubs: false });
  attempts.push({ copy: false, withSubs: !!o.sub });
  if (o.sub) attempts.push({ copy: false, withSubs: false, note: "Subtitles couldn't be added, so this clip has none." });
  let lastErr = null;
  try {
    for (const at of attempts) {
      try {
        await runClip(clipArgs(o, out, at), dur, send);
        const size = fs.statSync(out).size;
        if (size < 1024) throw new Error("the clip came out empty");
        send(1);
        return { path: out, size, name: path.basename(out), folder: clipDir(), note: at.note || "", fast: !!at.copy };
      } catch (err) {
        lastErr = err; try { fs.unlinkSync(out); } catch {}
        if (clipCancelled) throw err;
      }
    }
    throw lastErr;
  } finally {
    if (o.subFile) { try { fs.unlinkSync(path.join(TMP, o.subFile)); } catch {} }
  }
});
ipcMain.handle("clip-cancel", () => { clipCancelled = true; if (clipProc) clipProc.kill(); });
ipcMain.handle("show-item", (_e, p) => { if (fs.existsSync(p)) { shell.showItemInFolder(p); return true; } return false; });
ipcMain.handle("open-item", async (_e, p) => { if (!fs.existsSync(p)) return false; await shell.openPath(p); return true; });
ipcMain.handle("open-clips-folder", () => { fs.mkdirSync(clipDir(), { recursive: true }); return shell.openPath(clipDir()); });
ipcMain.handle("items-exist", (_e, list) => list.map(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }));

/* ---------- online subtitle search (OpenSubtitles.com and SubDL) ---------- */
// Accounts are kept on this computer only; the password is encrypted with Windows' own protection.
const { safeStorage } = require("electron");
const credsFile = () => path.join(app.getPath("userData"), "subtitle-accounts.json");
function readCreds(){ try { return JSON.parse(fs.readFileSync(credsFile(), "utf8")); } catch { return {}; } }
function writeCreds(c){ fs.mkdirSync(path.dirname(credsFile()), { recursive: true }); fs.writeFileSync(credsFile(), JSON.stringify(c)); }
function osPassword(c){
  if (!c.osPass) return "";
  try { return c.osPassEnc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(c.osPass, "base64")) : Buffer.from(c.osPass, "base64").toString("utf8"); } catch { return ""; }
}
ipcMain.handle("subs-creds-get", () => { const c = readCreds(); return { subdl: c.subdl || "", osKey: c.osKey || "", osUser: c.osUser || "", hasPass: !!c.osPass }; });
ipcMain.handle("subs-creds-set", (_e, patch) => {
  const c = readCreds();
  for (const k of ["subdl", "osKey", "osUser"]) if (k in patch) c[k] = String(patch[k] || "").trim();
  if ("osPass" in patch) {
    const p = String(patch.osPass || "");
    if (!p) { delete c.osPass; delete c.osPassEnc; }
    else if (safeStorage.isEncryptionAvailable()) { c.osPass = safeStorage.encryptString(p).toString("base64"); c.osPassEnc = true; }
    else { c.osPass = Buffer.from(p, "utf8").toString("base64"); c.osPassEnc = false; }
  }
  if ("osKey" in patch || "osUser" in patch || "osPass" in patch) osSession = null;
  writeCreds(c); return true;
});

const MOCK = process.env.CRAVE_SUBS_MOCK || "";          // test hook: a local stand-in for both services
const OS_API = MOCK ? MOCK + "/os/api/v1" : "https://api.opensubtitles.com/api/v1";
const SUBDL_API = MOCK ? MOCK + "/subdl/api/v1/subtitles" : "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DL = MOCK ? MOCK + "/subdl/dl" : "https://dl.subdl.com";
const uaString = () => `Crave v${app.getVersion()}`;
async function getJSON(url, opts = {}){
  const res = await net.fetch(url, opts);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = (body && (body.message || body.error || (body.errors && body.errors.join(", ")))) || `${res.status} ${res.statusText}`;
    const err = new Error(String(msg)); err.status = res.status; throw err;
  }
  return body;
}
// OpenSubtitles "moviehash": file size plus the 64-bit sums of the first and last 64 KB.
async function movieHash(p){
  const st = await fs.promises.stat(p); if (st.size < 131072) return null;
  const h = await fs.promises.open(p, "r");
  try {
    const a = Buffer.alloc(65536), b = Buffer.alloc(65536);
    await h.read(a, 0, 65536, 0); await h.read(b, 0, 65536, st.size - 65536);
    let sum = BigInt(st.size); const M = (1n << 64n) - 1n;
    for (const buf of [a, b]) for (let i = 0; i < 65536; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & M;
    return sum.toString(16).padStart(16, "0");
  } finally { await h.close(); }
}
let osSession = null, osLoggingIn = null; // { token, base, remaining }
function osLogin(c){
  if (!c.osUser || !c.osPass) return Promise.resolve(null);
  if (osSession) return Promise.resolve(osSession);
  // searches run side by side; they share one sign-in
  if (!osLoggingIn) osLoggingIn = osLoginNow(c).finally(() => { osLoggingIn = null; });
  return osLoggingIn;
}
async function osLoginNow(c){
  const r = await getJSON(OS_API + "/login", { method: "POST", headers: { "Api-Key": c.osKey, "User-Agent": uaString(), "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ username: c.osUser, password: osPassword(c) }) });
  const base = r.base_url && !MOCK ? `https://${String(r.base_url).replace(/^https?:\/\//, "")}/api/v1` : OS_API;
  osSession = { token: r.token, base, remaining: r.user && r.user.allowed_downloads };
  return osSession;
}
const osHeaders = (c, s) => Object.assign({ "Api-Key": c.osKey, "User-Agent": uaString(), Accept: "application/json" }, s ? { Authorization: "Bearer " + s.token } : {});
async function osSearch(c, q){
  let s = null; try { s = await osLogin(c); } catch (e) { osSession = null; if (e.status === 401) throw new Error("OpenSubtitles didn't accept your username or password"); }
  const params = {};
  if (q.hash) params.moviehash = q.hash;
  if (q.query) params.query = q.query.toLowerCase();
  if (q.year && !q.season) params.year = q.year;
  if (q.season) { params.season_number = q.season; params.type = "episode"; }
  if (q.episode) params.episode_number = q.episode;
  params.languages = q.lang || "en";
  params.order_by = "download_count";
  const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await getJSON(`${(s && s.base) || OS_API}/subtitles?${qs}`, { headers: osHeaders(c, s) });
  return (r.data || []).filter(d => d.attributes && d.attributes.files && d.attributes.files.length).map(d => {
    const a = d.attributes, f = a.feature_details || {};
    return { provider: "opensubtitles", id: String(a.files[0].file_id), release: a.release || a.files[0].file_name || f.title || "", file: a.files[0].file_name || "",
      lang: a.language || q.lang, downloads: a.download_count || 0, hi: !!a.hearing_impaired, exact: !!a.moviehash_match, ai: !!(a.ai_translated || a.machine_translated),
      title: f.movie_name || f.title || "", show: f.parent_title || "", year: f.year || "", season: f.season_number || null, episode: f.episode_number || null, uploader: a.uploader && a.uploader.name || "" };
  });
}
async function subdlSearch(c, q){
  const params = new URLSearchParams({ api_key: c.subdl, subs_per_page: "30", languages: (q.lang || "en").split("-")[0].toUpperCase() });
  if (q.fileName) params.set("file_name", q.fileName);
  if (q.query) params.set("film_name", q.query);
  if (q.season) { params.set("type", "tv"); params.set("season_number", q.season); if (q.episode) params.set("episode_number", q.episode); }
  else { params.set("type", "movie"); if (q.year) params.set("year", q.year); }
  const r = await getJSON(`${SUBDL_API}?${params}`, { headers: { "User-Agent": uaString(), Accept: "application/json" } });
  if (r && r.status === false) { if (/not found|no subtitles/i.test(r.error || "")) return []; throw new Error(r.error || "SubDL search failed"); }
  const t = (r.results && r.results[0]) || {};
  return (r.subtitles || []).map(sb => ({ provider: "subdl", id: sb.url, release: sb.release_name || sb.name || "", file: sb.name || "",
    lang: q.lang || "en", downloads: sb.download_count || 0, hi: !!sb.hi, exact: false, ai: false,
    title: t.name || "", year: t.year || "", season: sb.season || null, episode: sb.episode || null, uploader: sb.author || "", fullSeason: !!sb.full_season }));
}
ipcMain.handle("subs-search", async (_e, q) => {
  const c = readCreds(), jobs = [], errors = [];
  if (q.path && !q.hash) { try { q.hash = await movieHash(q.path); } catch {} }
  if (c.osKey && !q.subdlOnly) {      // automatic English fetches use SubDL only, keeping OpenSubtitles' daily downloads for you
    jobs.push(osSearch(c, q).catch(e => { errors.push("OpenSubtitles: " + e.message); return []; }));
    // a hash-only search finds exact matches even when the title guess is off
    if (q.hash && q.query) jobs.push(osSearch(c, { ...q, query: "", year: "" }).catch(() => []));
  }
  if (c.subdl) jobs.push(subdlSearch(c, q).catch(e => { errors.push("SubDL: " + e.message); return []; }));
  if (!jobs.length) return { results: [], errors: [], needsSetup: !q.subdlOnly };
  const seen = new Set(), results = [];
  for (const list of await Promise.all(jobs)) for (const r of list) { const k = r.provider + ":" + r.id; if (!seen.has(k)) { seen.add(k); results.push(r); } }
  results.sort((a, b) => (b.exact - a.exact) || (b.downloads - a.downloads));
  return { results, errors, hashed: !!q.hash, osRemaining: osSession && osSession.remaining };
});
const SUB_EXT = /\.(srt|ass|ssa|vtt|sub)$/i;
function pickFromZip(files, q){
  const names = Object.keys(files).filter(n => SUB_EXT.test(n) && files[n].length > 20);
  if (!names.length) return null;
  if (q.season && q.episode) {
    const re = new RegExp(`(s0*${q.season}[ ._-]*e0*${q.episode}\\b|\\b${q.season}x0*${q.episode}\\b)`, "i");
    const hit = names.find(n => re.test(n)); if (hit) return hit;
  }
  return names.sort((a, b) => (/\.srt$/i.test(b) - /\.srt$/i.test(a)) || files[b].length - files[a].length)[0];
}
async function subsDownloadNow({ provider, id, lang, season, episode, saveNextTo }){
  const c = readCreds();
  let name = "subtitle.srt", data = null;
  if (provider === "opensubtitles") {
    let s = null; try { s = await osLogin(c); } catch { osSession = null; }
    let r;
    try {
      r = await getJSON(`${(s && s.base) || OS_API}/download`, { method: "POST", headers: Object.assign(osHeaders(c, s), { "Content-Type": "application/json" }), body: JSON.stringify({ file_id: Number(id) || id }) });
    } catch (e) {
      if (e.status === 406 || /quota|limit|allowed/i.test(e.message)) throw new Error(`you've used today's OpenSubtitles downloads (${s ? "20 a day with your account" : "5 a day without an account; add your free account in Settings for 20"})`);
      throw e;
    }
    if (s && r.remaining != null) s.remaining = r.remaining;
    const res = await net.fetch(r.link, { headers: { "User-Agent": uaString() } });
    if (!res.ok) throw new Error("download failed (" + res.status + ")");
    data = Buffer.from(await res.arrayBuffer()); name = r.file_name || name;
    if (data[0] === 0x1f && data[1] === 0x8b) data = require("node:zlib").gunzipSync(data);
  } else if (provider === "subdl") {
    const res = await net.fetch(SUBDL_DL + (String(id).startsWith("/") ? id : "/" + id), { headers: { "User-Agent": uaString() } });
    if (!res.ok) throw new Error("download failed (" + res.status + ")");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const files = require("fflate").unzipSync(buf);
      const pick = pickFromZip(files, { season, episode });
      if (!pick) throw new Error("the download didn't contain a subtitle file");
      data = Buffer.from(files[pick]); name = path.basename(pick);
    } else { data = Buffer.from(buf); name = "subtitle.srt"; }
  } else throw new Error("unknown subtitle service");
  let savedTo = null;
  if (saveNextTo) {
    try {
      const dir = path.dirname(saveNextTo), base = path.basename(saveNextTo, path.extname(saveNextTo));
      const ext = (path.extname(name) || ".srt").toLowerCase(), code = (lang || "").toLowerCase().replace(/[^a-z-]/g, "");
      let target = path.join(dir, `${base}${code ? "." + code : ""}${ext}`), n = 2;
      while (fs.existsSync(target)) target = path.join(dir, `${base}${code ? "." + code : ""} (${n++})${ext}`);
      fs.writeFileSync(target, data); savedTo = target;
    } catch {}
  }
  return { name, data: new Uint8Array(data), savedTo, osRemaining: osSession && osSession.remaining };
}
ipcMain.handle("subs-download", (_e, o) => subsDownloadNow(o));

/* ---------- subtitle sync: line the subtitles up with the speech in the video ----------
   Reads a few minutes of the sound, marks where people are talking (10 ms steps), then finds the
   shift (and, for subtitles made for a different frame rate, the stretch) where the subtitle lines
   best cover the talking. */
function speechFrames(input, track, from, dur){
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-ss", Math.max(0, from).toFixed(2), ...netIn(input), "-i", input, "-t", dur.toFixed(2),
      "-map", `0:a:${track || 0}`, "-vn", "-sn", "-ac", "1", "-ar", "16000", "-af", "highpass=f=200,lowpass=f=3400", "-f", "s16le", "pipe:1"];
    const p = spawn(ffmpegPath(), args, { windowsHide: true }); const parts = []; let err = "";
    p.stdout.on("data", d => parts.push(d)); p.stderr.on("data", d => { err = (err + d).slice(-800); });
    p.on("error", reject);
    p.on("close", () => {
      const buf = Buffer.concat(parts), n = Math.floor(buf.length / 2 / 160);
      if (n < 1000) return reject(new Error(err.trim().split("\n").pop() || "couldn't read the sound"));
      const db = new Float32Array(n);
      for (let f = 0; f < n; f++) { let sum = 0; for (let i = 0; i < 160; i++) { const x = buf.readInt16LE((f * 160 + i) * 2) / 32768; sum += x * x; } db[f] = 10 * Math.log10(sum / 160 + 1e-10); }
      const sorted = Array.from(db).sort((a, b) => a - b), floor = sorted[Math.floor(n * 0.2)], loud = sorted[Math.floor(n * 0.95)];
      const thr = Math.max(-55, floor + Math.max(6, (loud - floor) * 0.35));
      // talking = above the threshold, widened equally on both sides (so the estimate isn't pulled late)
      const raw = new Uint8Array(n); for (let f = 0; f < n; f++) raw[f] = db[f] > thr ? 1 : 0;
      const A = new Int8Array(n).fill(-1), W = 6;
      for (let f = 0; f < n; f++) if (raw[f]) for (let k = Math.max(0, f - W); k <= Math.min(n - 1, f + W); k++) A[k] = 1;
      resolve(A);
    });
  });
}
ipcMain.handle("subs-sync", async (_e, { input, track, from, dur, cues }) => {
  if (!input) throw new Error("this video can't be analysed");
  if (!cues || cues.length < 8) throw new Error("not enough subtitle lines loaded yet");
  const A = await speechFrames(input, track, from, dur), n = A.length, step = 0.01;
  const P = new Int32Array(n + 1); for (let i = 0; i < n; i++) P[i + 1] = P[i] + A[i];
  const score = (scale, off) => { let sc = 0;
    for (const [a, b] of cues) { let i = Math.round((a * scale + off - from) / step), j = Math.round((b * scale + off - from) / step);
      if (j <= 0 || i >= n) continue; i = Math.max(0, i); j = Math.min(n, j); sc += P[j] - P[i]; }
    return sc; };
  const centre = from + n * step / 2, results = [];
  for (const scale of [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25]) {
    const base = centre - centre * scale;          // the offset that keeps the middle of the window in place
    let best = -Infinity, bestOff = 0; const all = [];
    for (let o = -90; o <= 90; o += 0.05) { const v = score(scale, base + o); all.push(v); if (v > best) { best = v; bestOff = base + o; } }
    for (let o = bestOff - 0.06; o <= bestOff + 0.06; o += 0.01) { const v = score(scale, o); if (v > best) { best = v; bestOff = o; } }
    const mean = all.reduce((x, y) => x + y, 0) / all.length, sd = Math.sqrt(all.reduce((x, y) => x + (y - mean) ** 2, 0) / all.length) || 1;
    results.push({ scale, offset: Math.round(bestOff * 100) / 100, score: best, z: (best - mean) / sd });
  }
  results.sort((a, b) => b.score - a.score);
  let r = results[0]; const plain = results.find(x => x.scale === 1);
  if (r.scale !== 1 && r.score < plain.score * 1.06 + 20) r = plain;   // only stretch when it clearly fits better
  const speech = A.reduce((x, y) => x + (y > 0 ? 1 : 0), 0) / n;
  return { offset: r.offset, scale: r.scale, z: Math.round(r.z * 10) / 10, confident: r.z >= 4.5 && speech > 0.08 && speech < 0.92, speech: Math.round(speech * 100) };
});
// The OpenSubtitles hash of a streamed file, from two small range requests (first and last 64 KB).
async function urlMovieHash(u){
  const get = async range => {
    const r = await fetch(u, { headers: { Range: range, "User-Agent": NET_UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.status !== 206) throw new Error("no range support (" + r.status + ")");
    const total = +String(r.headers.get("content-range") || "").split("/")[1] || 0;
    return { buf: Buffer.from(await r.arrayBuffer()), total };
  };
  const a = await get("bytes=0-65535"), size = a.total;
  if (!size || size < 131072 || a.buf.length < 65536) return null;
  const b = await get(`bytes=${size - 65536}-${size - 1}`);
  if (b.buf.length < 65536) return null;
  let sum = BigInt(size); const M = (1n << 64n) - 1n;
  for (const buf of [a.buf, b.buf]) for (let i = 0; i < 65536; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & M;
  return sum.toString(16).padStart(16, "0");
}
// English subtitles for whatever is playing, with no questions asked:
// 1. identify the video by its hash on OpenSubtitles (searching is free) to learn the show, season and episode,
// 2. get them from SubDL (no daily limit) using that, or the file name,
// 3. only if SubDL has nothing, use the exact OpenSubtitles match (1 of the daily downloads).
const simpleWords = t => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !/^(the|and)$/.test(w));
ipcMain.handle("subs-auto-en", async (_e, { input, fileName, guess = {}, saveNextTo }) => {
  const c = readCreds(), log = [];
  if (!c.subdl && !c.osKey) return { none: true, reason: "no subtitle accounts" };
  let hash = null;
  try { hash = /^https?:/i.test(input) ? await urlMovieHash(input) : input ? await movieHash(input) : null; } catch (e) { log.push("hash: " + e.message); }
  let id = null, exact = [];
  if (hash && c.osKey) {
    try {
      exact = (await osSearch(c, { hash, lang: "en" })).filter(x => x.exact && !x.ai);
      const f = exact[0];
      if (f) id = { title: f.show || f.title, year: f.year, season: f.season || "", episode: f.episode || "" };
    } catch (e) { log.push("OpenSubtitles: " + e.message); }
  }
  const tries = [];
  if (id && id.title) tries.push({ query: id.title, year: id.year, season: id.season, episode: id.episode, lang: "en" });
  if (guess.title && (guess.season || guess.year)) tries.push({ query: guess.title, year: guess.year, season: guess.season || "", episode: guess.episode || "", lang: "en" });
  if (fileName) tries.push({ fileName, lang: "en", strict: true });
  if (c.subdl) for (const q of tries) {
    try {
      let hits = (await subdlSearch(c, q)).filter(x => !x.ai);
      const ep = q.episode || (id && id.episode);
      if (ep) hits = hits.filter(x => !x.episode || +x.episode === +ep);
      if (q.strict && guess.title) { const want = simpleWords(guess.title); hits = hits.filter(x => !want.length || simpleWords(x.title + " " + x.release).some(w => want.includes(w))); }
      // prefer subtitles made for this release (same group, source and resolution as the video's file name)
      const tok = x => new Set(String(x || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !/^(the|and|mkv|mp4|srt)$/.test(w)));
      const mine = tok(fileName || ""), fit = x => { let k = 0; for (const w of tok(x.release)) if (mine.has(w)) k++; return k; };
      hits.sort((a, b) => (fit(b) - fit(a)) || (+a.hi - +b.hi) || (+a.fullSeason - +b.fullSeason) || (b.downloads - a.downloads));
      if (!hits.length) continue;
      const x = hits[0];
      const d = await subsDownloadNow({ provider: "subdl", id: x.id, lang: "en", season: x.season || q.season || (id && id.season), episode: x.episode || ep, saveNextTo });
      return { ...d, source: "SubDL", release: x.release || x.title, identified: id };
    } catch (e) { log.push("SubDL: " + e.message); }
  }
  if (exact.length) {
    try { const d = await subsDownloadNow({ provider: "opensubtitles", id: exact[0].id, lang: "en", saveNextTo }); return { ...d, source: "OpenSubtitles (exact match)", release: exact[0].release, identified: id }; }
    catch (e) { log.push("OpenSubtitles download: " + e.message); }
  }
  return { none: true, identified: id, reason: log.join("; ") || "no English subtitles found" };
});
// Subtitle files next to the video (Movie.srt, Movie.en.srt, Subs/…), like VLC.
ipcMain.handle("sidecar-subs", async (_e, videoPath) => {
  try {
    const dir = path.dirname(videoPath), base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
    const found = [];
    const scan = (d, any) => { for (const n of fs.readdirSync(d)) { if (!SUB_EXT.test(n) || /\.sub$/i.test(n)) continue; if (any || n.toLowerCase().startsWith(base)) found.push(path.join(d, n)); } };
    scan(dir, false);
    for (const sub of ["Subs", "Subtitles", "subs", "subtitles"]) { const d = path.join(dir, sub); if (fs.existsSync(d) && fs.statSync(d).isDirectory()) scan(d, true); }
    return [...new Set(found)].slice(0, 12).filter(p => fs.statSync(p).size < 5e6).map(p => ({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
  } catch { return []; }
});

/* ---------- network logos (the company's own logo files, used as watermarks) ---------- */
const logoDir = () => path.join(app.getPath("userData"), "logos");
const logoIndex = () => path.join(logoDir(), "logos.json");
function readLogos(){ try { return JSON.parse(fs.readFileSync(logoIndex(), "utf8")); } catch { return []; } }
function writeLogos(list){ fs.mkdirSync(logoDir(), { recursive: true }); fs.writeFileSync(logoIndex(), JSON.stringify(list, null, 1)); }
const logoPath = id => path.join(logoDir(), `${String(id).replace(/[^a-z0-9-]/gi, "")}.png`);
ipcMain.handle("logos-list", () => readLogos().filter(l => fs.existsSync(logoPath(l.id))).map(l => ({ ...l, url: pathToFileURL(logoPath(l.id)).href + "?v=" + (l.v || 0) })));
ipcMain.handle("logos-add", (_e, { name, png, w, h }) => {
  const id = "lg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(logoDir(), { recursive: true });
  fs.writeFileSync(logoPath(id), Buffer.from(png));
  const list = readLogos(); list.push({ id, name: String(name || "Logo").slice(0, 60), w, h, v: 1 }); writeLogos(list);
  return id;
});
ipcMain.handle("logos-rename", (_e, { id, name }) => { const list = readLogos(); const l = list.find(x => x.id === id); if (l) { l.name = String(name || l.name).slice(0, 60); writeLogos(list); } return true; });
ipcMain.handle("logos-remove", (_e, id) => { writeLogos(readLogos().filter(x => x.id !== id)); try { fs.unlinkSync(logoPath(id)); } catch {} return true; });

/* ---------- self-updating from GitHub Releases ---------- */
const pkg = require("./package.json");
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_DIR;
let updState = { state: "idle", current: app.getVersion() };
function setUpd(s){ updState = { ...updState, ...s, current: app.getVersion() }; if (win && !win.isDestroyed()) win.webContents.send("update", updState); }
let autoUpdater = null;
function initUpdater(){
  // Only real installs update themselves. CRAVE_UPDATE_TEST lets a dev build try it against a test server.
  if (!app.isPackaged && !process.env.CRAVE_UPDATE_TEST) return;
  try {
    const eu = require("electron-updater");
    // Test mode always exercises the Windows (NSIS) updater, whatever machine it runs on.
    autoUpdater = process.env.CRAVE_UPDATE_TEST ? new eu.NsisUpdater() : eu.autoUpdater;
  } catch (e) { console.error("updater unavailable", e); return; }
  if (process.env.CRAVE_UPDATE_TEST) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.updateConfigPath = process.env.CRAVE_UPDATE_TEST; }
  autoUpdater.autoDownload = !PORTABLE;          // the portable exe can't replace itself; it offers a download link
  autoUpdater.autoInstallOnAppQuit = true;      // a downloaded update also installs next time Crave closes
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => setUpd({ state: "checking" }));
  autoUpdater.on("update-not-available", () => setUpd({ state: "current", checkedAt: Date.now() }));
  autoUpdater.on("update-available", info => setUpd({ state: PORTABLE ? "manual" : "downloading", version: info.version, percent: 0, url: pkg.craveReleasesUrl || null }));
  autoUpdater.on("download-progress", p => setUpd({ state: "downloading", percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", info => setUpd({ state: "ready", version: info.version }));
  autoUpdater.on("error", err => setUpd({ state: "error", error: String(err && err.message || err).split("\n")[0].slice(0, 200) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
ipcMain.handle("update-state", () => updState);
ipcMain.handle("update-check", async () => {
  if (!autoUpdater) return setUpd({ state: "unavailable" });
  try { await autoUpdater.checkForUpdates(); } catch (e) { setUpd({ state: "error", error: String(e.message || e).slice(0, 200) }); }
});
ipcMain.handle("update-install", () => { if (autoUpdater && updState.state === "ready") setImmediate(() => autoUpdater.quitAndInstall(true, true)); });
ipcMain.handle("open-external", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
app.whenReady().then(initUpdater);

/* ---------- shutdown ---------- */
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  try { stopAstreams(); for (const p of sstreams.values()) p.kill(); } catch {}
  try { if (clipProc) { clipCancelled = true; clipProc.kill(); } } catch {}
  try { if (ffProc) ffProc.kill(); } catch {}
  try { if (tclient) tclient.destroy(); } catch {}
  for (const h of fds.values()) h.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
