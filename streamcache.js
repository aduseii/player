// Stream cache: plays links through a small local server that
//  - downloads with several connections at once (debrid servers often cap each connection),
//  - keeps reading ahead of where you are, so forward skips land on data that is already here,
//  - keeps what it fetched, so backward skips never re-download,
//  - remembers where the link redirects to, so seeks skip the slow "resolve the link" step,
//  - serves the picture, Crave's sound decoder, subtitles and clip export from one download.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");

const CHUNK = 1 << 20;            // 1 MB pieces
const BLOCK = 16;                 // pieces per cache file (16 MB): small files, no huge zero-filled writes on Windows
const RUN = 4;                    // pieces per request
const WORKERS = 4;                // parallel connections
const AHEAD = 384 * CHUNK;        // read this far ahead of where you're watching
const KEEP = 3 * 1024 * CHUNK;    // keep at most ~3 GB per video on disk

class Stream {
  constructor(id, url, dir, ua){
    Object.assign(this, { id, url, dir, ua, final: null, size: 0, type: "application/octet-stream", n: 0, have: null,
      inflight: new Map(), waiters: new Map(), readers: new Set(), fds: new Map(), workers: 0, errors: 0, dead: false, focus: 0, bytes: 0, used: new Map() });
    fs.mkdirSync(dir, { recursive: true });
    this.ready = this.init();
  }
  async init(){
    const r = await this.req(0, CHUNK - 1);
    const cr = r.headers.get("content-range") || "";
    const size = +cr.split("/")[1] || 0;
    if (r.status !== 206 || !size) { try { await r.body.cancel(); } catch {} throw new Error("the server doesn't support jumping inside the file"); }
    this.final = r.url && r.url !== this.url ? r.url : null;
    this.type = r.headers.get("content-type") || this.type;
    this.size = size; this.n = Math.ceil(size / CHUNK); this.have = new Uint8Array(this.n);
    await this.consume(r, 0, null);
    this.pump();
  }
  req(a, b, signal){
    return fetch(this.final || this.url, { headers: { Range: `bytes=${a}-${b}`, "User-Agent": this.ua, "Accept-Encoding": "identity" }, redirect: "follow", signal });
  }
  blockFile(b){ return path.join(this.dir, b + ".bin"); }
  async fd(b){
    let f = this.fds.get(b); if (f) return f;
    f = await fs.promises.open(this.blockFile(b), fs.existsSync(this.blockFile(b)) ? "r+" : "w+");
    this.fds.set(b, f); this.used.set(b, Date.now());
    if (this.fds.size > 48) { const [ob, of] = this.fds.entries().next().value; this.fds.delete(ob); of.close().catch(() => {}); }
    return f;
  }
  async writeAt(pos, buf){
    while (buf.length) {
      const b = Math.floor(pos / (CHUNK * BLOCK)), off = pos - b * CHUNK * BLOCK, len = Math.min(buf.length, CHUNK * BLOCK - off);
      await (await this.fd(b)).write(buf, 0, len, off);
      pos += len; buf = buf.subarray(len);
    }
  }
  async readAt(pos, len){
    const b = Math.floor(pos / (CHUNK * BLOCK)), off = pos - b * CHUNK * BLOCK;
    len = Math.min(len, CHUNK * BLOCK - off);
    const buf = Buffer.allocUnsafe(len); const { bytesRead } = await (await this.fd(b)).read(buf, 0, len, off);
    this.used.set(b, Date.now());
    return buf.subarray(0, bytesRead);
  }
  // Write a response body into the cache, marking each 1 MB piece as it completes.
  async consume(r, start, run){
    let pos = start, idle;
    const ctl = run && run.ctl, arm = () => { clearTimeout(idle); idle = setTimeout(() => ctl && ctl.abort(), 20000); };
    arm();
    try {
      for await (const part of r.body) {
        if (this.dead) break;
        arm();
        const buf = Buffer.from(part);
        await this.writeAt(pos, buf);
        const before = Math.floor(pos / CHUNK); pos += buf.length; this.bytes += buf.length;
        const done = pos >= this.size ? this.n : Math.floor(pos / CHUNK);
        for (let c = before; c < done; c++) if (!this.have[c]) { this.have[c] = 1; this.wake(c); }
        if (run && done >= run.end) break;
      }
    } finally { clearTimeout(idle); }
  }
  wake(c){ const w = this.waiters.get(c); if (w) { this.waiters.delete(c); w.forEach(f => f.ok()); } }
  wait(c){
    if (this.have[c]) return Promise.resolve();
    return new Promise((ok, fail) => { const list = this.waiters.get(c) || []; list.push({ ok, fail }); this.waiters.set(c, list); this.pump(); });
  }
  // Pick what to fetch next: pieces someone is waiting for first, then read ahead of the viewer.
  pump(){
    if (this.dead || !this.have) return;
    const wanted = [...this.waiters.keys()].sort((a, b) => a - b);
    const lo = this.readers.size ? Math.min(...[...this.readers].map(r => r.chunk)) : this.focus;
    const ahead = Math.min(this.n, lo + Math.ceil(AHEAD / CHUNK));
    // connections working far from where anyone is watching are stopped, to free them for the new place
    for (const [s, run] of this.inflight) if (!wanted.some(c => c >= s && c < run.end) && (run.end < lo || s > ahead)) run.ctl.abort();
    while (this.workers < WORKERS) {
      let s = -1;
      for (const c of wanted) if (!this.have[c] && !this.isInflight(c)) { s = c; break; }
      if (s < 0) for (let c = lo; c < ahead; c++) if (!this.have[c] && !this.isInflight(c)) { s = c; break; }
      if (s < 0) break;
      let e = s + 1; while (e < this.n && e - s < RUN && !this.have[e] && !this.isInflight(e)) e++;
      this.fetchRun(s, e);
    }
    this.trim(lo);
  }
  isInflight(c){ for (const [s, run] of this.inflight) if (c >= s && c < run.end) return true; return false; }
  async fetchRun(s, e){
    const run = { end: e, ctl: new AbortController() };
    this.inflight.set(s, run); this.workers++;
    try {
      const r = await this.req(s * CHUNK, Math.min(this.size, e * CHUNK) - 1, run.ctl.signal);
      if (r.status !== 206) {
        try { await r.body.cancel(); } catch {}
        if (this.final && (r.status === 403 || r.status === 404 || r.status === 410)) this.final = null;   // redirect target expired: resolve the link again
        throw new Error("server answered " + r.status);
      }
      await this.consume(r, s * CHUNK, run);
      this.errors = 0;
    } catch (err) {
      if (!run.ctl.signal.aborted && ++this.errors >= 8) {    // keep failing: let readers retry instead of hanging
        for (const [c, list] of this.waiters) list.forEach(f => f.fail(err)); this.waiters.clear(); this.errors = 0;
      }
      if (!run.ctl.signal.aborted) await new Promise(r => setTimeout(r, Math.min(4000, 300 * this.errors)));
    } finally {
      this.inflight.delete(s); this.workers--;
      if (!this.dead) setImmediate(() => this.pump());
    }
  }
  // Disk use: drop the cache files furthest from where you're watching once a video passes ~3 GB.
  trim(lo){
    const blocks = new Set(); for (let c = 0; c < this.n; c++) if (this.have[c]) blocks.add(Math.floor(c / BLOCK));
    if (blocks.size * BLOCK * CHUNK <= KEEP) return;
    const here = Math.floor(lo / BLOCK);
    const far = [...blocks].filter(b => Math.abs(b - here) > 2).sort((a, b) => Math.abs(b - here) - Math.abs(a - here));
    for (const b of far.slice(0, blocks.size - Math.floor(KEEP / (BLOCK * CHUNK)))) {
      for (let c = b * BLOCK; c < Math.min(this.n, (b + 1) * BLOCK); c++) this.have[c] = 0;
      const f = this.fds.get(b); if (f) { this.fds.delete(b); f.close().catch(() => {}); }
      fs.rm(this.blockFile(b), { force: true }, () => {});
    }
  }
  close(){
    this.dead = true;
    for (const run of this.inflight.values()) run.ctl.abort();
    for (const [, list] of this.waiters) list.forEach(f => f.fail(new Error("closed"))); this.waiters.clear();
    for (const f of this.fds.values()) f.close().catch(() => {});
    this.fds.clear();
    setTimeout(() => fs.rm(this.dir, { recursive: true, force: true }, () => {}), 500);
  }
  stats(){ let got = 0; if (this.have) for (let c = 0; c < this.n; c++) got += this.have[c]; return { size: this.size, cached: got * CHUNK, connections: this.workers }; }
}

function create({ dir, ua }){
  const streams = new Map(); let port = 0, seq = 0;
  const server = http.createServer(async (req, res) => {
    const m = /^\/s\/([a-z0-9]+)\//.exec(req.url || "");
    const st = m && streams.get(m[1]);
    if (!st) { res.writeHead(404); res.end(); return; }
    try { await st.ready; } catch { res.writeHead(502); res.end(); return; }
    const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    let start = 0, end = st.size - 1;
    if (rg) { if (rg[1]) start = +rg[1]; if (rg[2]) end = Math.min(end, +rg[2]); if (!rg[1] && rg[2]) { start = Math.max(0, st.size - +rg[2]); end = st.size - 1; } }
    if (start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(rg ? 206 : 200, Object.assign({ "Content-Type": st.type, "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      rg ? { "Content-Range": `bytes ${start}-${end}/${st.size}` } : {}));
    if (req.method === "HEAD") { res.end(); return; }
    const reader = { chunk: Math.floor(start / CHUNK) }; st.readers.add(reader); st.focus = reader.chunk; st.pump();
    let closed = false; req.on("close", () => { closed = true; });
    try {
      let p = start;
      while (p <= end && !closed && !st.dead) {
        const c = Math.floor(p / CHUNK); reader.chunk = c;
        if (!st.have[c]) { st.pump(); await st.wait(c); }
        const buf = await st.readAt(p, Math.min(end + 1, (c + 1) * CHUNK) - p);
        if (!buf.length) break;
        p += buf.length;
        if (!res.write(buf)) await new Promise(r => { res.once("drain", r); res.once("close", r); });
      }
    } catch {} finally { st.readers.delete(reader); st.pump(); res.end(); }
  });
  const listening = new Promise(ok => server.listen(0, "127.0.0.1", () => { port = server.address().port; ok(); }));
  server.keepAliveTimeout = 30000;
  return {
    async open(url){
      await listening;
      for (const s of streams.values()) if (s.url === url && !s.dead) return { id: s.id, url: `http://127.0.0.1:${port}/s/${s.id}/${encodeURIComponent(path.basename(new URL(url).pathname) || "video")}` };
      const id = (Date.now().toString(36) + (seq++).toString(36)).replace(/[^a-z0-9]/g, "");
      const st = new Stream(id, url, path.join(dir, id), ua);
      streams.set(id, st);
      try { await st.ready; } catch (e) { st.close(); streams.delete(id); throw e; }
      return { id, url: `http://127.0.0.1:${port}/s/${id}/${encodeURIComponent(path.basename(new URL(url).pathname) || "video")}` };
    },
    close(id){ const s = streams.get(id); if (s) { s.close(); streams.delete(id); } },
    closeAll(except){ for (const [id, s] of streams) if (id !== except) { s.close(); streams.delete(id); } },
    stats(id){ const s = streams.get(id); return s ? s.stats() : null; },
    shutdown(){ for (const s of streams.values()) s.close(); streams.clear(); try { server.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}
module.exports = { create };
