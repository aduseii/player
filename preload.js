// The small, safe surface the player page gets inside the desktop app (window.craveNative).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

let progressCb = null;
ipcRenderer.on("convert-progress", (_e, p) => { if (progressCb) progressCb(p); });

contextBridge.exposeInMainWorld("craveNative", {
  desktop: true,
  pathFor: f => { try { return webUtils.getPathForFile(f) || null; } catch { return null; } },
  read: (p, a, b) => ipcRenderer.invoke("read", p, a, b),
  statPath: p => ipcRenderer.invoke("stat-path", p),
  convertAudio: (opts, onProgress) => {
    progressCb = onProgress;
    return ipcRenderer.invoke("convert-audio", opts).finally(() => { progressCb = null; });
  },
  cancelConvert: () => ipcRenderer.invoke("convert-cancel"),
  torrentAdd: src => ipcRenderer.invoke("torrent-add", src),
  torrentStats: () => ipcRenderer.invoke("torrent-stats"),
  torrentStop: () => ipcRenderer.invoke("torrent-stop"),
  openShotsFolder: () => ipcRenderer.invoke("open-shots-folder"),
  onOpen: cb => ipcRenderer.on("open", (_e, items) => cb(items)),
  onSaved: cb => ipcRenderer.on("saved", (_e, p) => cb(p)),
  updateState: () => ipcRenderer.invoke("update-state"),
  checkForUpdates: () => ipcRenderer.invoke("update-check"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  openExternal: url => ipcRenderer.invoke("open-external", url),
  onUpdate: cb => ipcRenderer.on("update", (_e, s) => cb(s)),
  probe: input => ipcRenderer.invoke("probe", input),
  astreamStart: opts => ipcRenderer.invoke("astream-start", opts),
  astreamPause: id => ipcRenderer.invoke("astream-pause", id),
  astreamResume: id => ipcRenderer.invoke("astream-resume", id),
  astreamStop: () => ipcRenderer.invoke("astream-stop"),
  onAstreamData: cb => ipcRenderer.on("astream-data", (_e, id, d) => cb(id, d)),
  onAstreamEnd: cb => ipcRenderer.on("astream-end", (_e, id, code, msg) => cb(id, code, msg)),
  subStart: opts => ipcRenderer.invoke("sub-start", opts),
  subStopAll: () => ipcRenderer.invoke("sub-stop-all"),
  onSubData: cb => ipcRenderer.on("sub-data", (_e, id, d) => cb(id, d)),
  onSubEnd: cb => ipcRenderer.on("sub-end", (_e, id, code, msg) => cb(id, code, msg))
});
