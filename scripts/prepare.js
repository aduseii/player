// Builds app/ from src/crave.html: swaps every CDN load for a local copy so the desktop app works offline.
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname.endsWith("scripts") ? path.dirname(__dirname) : __dirname;
const nm = p => path.join(root, "node_modules", p);
const out = path.join(root, "app");
const vendor = path.join(out, "vendor");

fs.rmSync(out, { recursive: true, force: true });
for (const d of ["", "ffmpeg", "core", "fonts"]) fs.mkdirSync(path.join(vendor, d), { recursive: true });

const copy = (from, to) => fs.copyFileSync(from, path.join(vendor, to));
copy(nm("hls.js/dist/hls.min.js"), "hls.min.js");
copy(nm("dashjs/dist/dash.all.min.js"), "dash.all.min.js");
copy(nm("webtorrent-browser/webtorrent.min.js"), "webtorrent.min.js");
for (const f of fs.readdirSync(nm("@ffmpeg/ffmpeg/dist/esm"))) if (f.endsWith(".js")) copy(nm("@ffmpeg/ffmpeg/dist/esm/" + f), "ffmpeg/" + f);
for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) copy(nm("@ffmpeg/core/dist/esm/" + f), "core/" + f);

// Fonts: same families the web page loads from Google Fonts.
const fontSets = [
  ["@fontsource-variable/bricolage-grotesque", ["opsz.css"], [["Bricolage Grotesque Variable", "Bricolage Grotesque"]]],
  ["@fontsource/figtree", ["400.css", "500.css", "600.css"], []],
  ["@fontsource/jetbrains-mono", ["400.css", "500.css"], []]
];
let css = "";
for (const [pkg, files, renames] of fontSets) {
  const dir = path.join(vendor, "fonts", path.basename(pkg));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    let c = fs.readFileSync(nm(`${pkg}/${f}`), "utf8");
    // keep only latin + latin-ext faces, which is all the UI uses
    c = c.replace(/\/\*[^*]*\*\/\s*@font-face\s*\{[^}]*\}/g, block => /latin(-ext)?\b/.test(block.split("*/")[0]) && !/cyrillic|greek|vietnamese/.test(block.split("*/")[0]) ? block : "");
    for (const m of c.matchAll(/url\(\.\/files\/([^)]+\.woff2)\)/g)) fs.copyFileSync(nm(`${pkg}/files/${m[1]}`), path.join(dir, m[1]));
    c = c.replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, `url(./${path.basename(pkg)}/$1)`).replace(/,\s*url\([^)]+\.woff\)[^;]*/g, "");
    for (const [a, b] of renames) c = c.split(`'${a}'`).join(`'${b}'`);
    css += c + "\n";
  }
}
fs.writeFileSync(path.join(vendor, "fonts", "fonts.css"), css);

let html = fs.readFileSync(path.join(root, "src", "crave.html"), "utf8");
const swap = (from, to) => { if (!html.includes(from)) throw new Error("prepare: expected text not found: " + from.slice(0, 60)); html = html.split(from).join(to); };
html = html.replace(/<link rel="preconnect"[^>]*>\n?/g, "");
html = html.replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^"]*">/, '<link rel="stylesheet" href="vendor/fonts/fonts.css">');
swap('"https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"', '"vendor/hls.min.js"');
swap('"https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js"', '"vendor/dash.all.min.js"');
swap('"https://cdn.jsdelivr.net/npm/webtorrent@1.9.7/webtorrent.min.js"', '"vendor/webtorrent.min.js"');
swap('"https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/"', 'location.origin + "/vendor/ffmpeg/"');
swap('"https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/"', 'location.origin + "/vendor/core/"');
if (/https:\/\/(cdn\.jsdelivr|unpkg|fonts\.googleapis)/.test(html)) throw new Error("prepare: a CDN reference is left in the page");
fs.writeFileSync(path.join(out, "index.html"), html);

const size = d => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`app/ ready: ${(size(out) / 1048576).toFixed(1)} MB`);
