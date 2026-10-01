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
    const dir = path.join(app.getPath("pictures"), "Crave");
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
    backgroundColor: "#0c0b14", title: "Crave", show: false,
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
ipcMain.handle("open-shots-folder", () => { const dir = path.join(app.getPath("pictures"), "Crave"); fs.mkdirSync(dir, { recursive: true }); return shell.openPath(dir); });

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
    const args = ["-hide_banner", "-nostdin", "-y", "-i", input, "-map", `0:a:${track}`, "-vn", "-sn", "-dn"]
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
      else if (m[3] === "Video") { if (!/attached pic/.test(l)) res.video.push(s); }
      else res.subs.push(s);
      last = s; continue;
    }
    if (/^\s*Stream #/.test(l)) { last = null; continue; }
    const t = l.match(/^\s{4,}title\s*:\s*(.+)$/);
    if (t && last) last.title = t[1].trim();
  }
  return res;
}
ipcMain.handle("probe", (_e, input) => new Promise(resolve => {
  const p = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-i", input], { windowsHide: true });
  let err = "";
  const kill = setTimeout(() => { try { p.kill(); } catch {} }, 20000);
  p.stderr.on("data", d => { err += d; });
  p.on("error", () => { clearTimeout(kill); resolve(null); });
  p.on("close", () => { clearTimeout(kill); const r = parseProbe(err); resolve(r.video.length || r.audio.length || r.subs.length ? r : null); });
}));

/* ---------- live audio: any codec, converted on the fly from the playback position ---------- */
const astreams = new Map();
function stopAstreams(){ for (const p of astreams.values()) { try { p.kill(); } catch {} } astreams.clear(); }
ipcMain.handle("astream-start", (e, { id, input, track, start }) => {
  stopAstreams();
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error"];
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", input, "-map", `0:a:${track}`, "-vn", "-sn", "-dn",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
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
  args.push("-copyts", "-i", input);
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
  try { if (ffProc) ffProc.kill(); } catch {}
  try { if (tclient) tclient.destroy(); } catch {}
  for (const h of fds.values()) h.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});
