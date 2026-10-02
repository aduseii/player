# Crave

Crave is a video player for links, HLS/DASH streams, torrents and files on your computer, with built-in subtitle detection, audio fixing, marks and screenshots.

## How updates work

Every time files change in this repository, GitHub builds the Windows installer (the **Build and release Crave** workflow under the **Actions** tab) and publishes it on the **Releases** page. Installed copies of Crave check that page on launch and every six hours, download the new version quietly, and show **"Crave x.y.z is ready · Restart now"**. If you pick Later, the update installs the next time Crave closes.

A build only publishes when `"version"` in `package.json` is higher than the last release. Each change should raise it: `1.1.0` → `1.1.1` for fixes, `1.2.0` for new features.

### Publishing a change from the GitHub website

1. Open the repository, click **Add file → Upload files**, and drop in the changed files, keeping their folders (for example `src/crave.html`).
2. Click **Commit changes**.
3. Open the **Actions** tab. The build takes about 10 minutes. A green tick means the new version is on the Releases page and installed copies will pick it up.

If a build fails, open it in the Actions tab; the red step shows what went wrong.

## Building on your own computer (optional)

You need [Node.js](https://nodejs.org) 20 or newer.

1. Run `npm install` in this folder.
2. Put a Windows `ffmpeg.exe` in `bin` (run `npm i --no-save ffmpeg-static@5.2.0` and copy `node_modules/ffmpeg-static/ffmpeg.exe` there).
3. Run `npm run dist:win`. The installer appears in `dist`. To try the app without building, run `npm start`.

## Where things live

- `src/crave.html` is the player itself, the same page as the web version. Almost every feature is in this file.
- `scripts/prepare.js` turns it into `app/index.html`, swapping online libraries for local copies so the app works offline.
- `main.js` runs the window, local file server, bundled ffmpeg, torrent engine, screenshot saving and updates.
- `preload.js` is the small bridge the page uses to reach those (`window.craveNative`).
- `build/icon.ico` and `build/icon.png` are the app icon; replace both to change it.
- `scripts/after-pack.js` stamps the icon and version details into `Crave.exe`.
- `.github/workflows/release.yml` is the automatic build.

## Notes

- The installer isn't code-signed, so Windows SmartScreen warns on first install ("More info → Run anyway"). Updates install without that prompt.
- The portable exe can't replace itself; it shows a download link when a new version is out.
- Screenshots save to `Pictures\Crave` and clips to `Videos\Crave Clips` (both changeable in Settings).
- Network logos you add in Settings are stored as PNG files in `%APPDATA%\Crave\logos`. Crave ships no logos of its own. Torrent downloads are temporary and cleared when Crave closes.
- HDR video (HDR10, HLG, Dolby Vision) plays in true HDR when Windows HDR is on. HDR mode (Natural / Vivid) is a live GPU enhancement for standard videos; on PCs without GPU acceleration it uses a lighter filter.
- ffmpeg is GPL software by the FFmpeg developers; its license ships beside it as `ffmpeg-LICENSE.txt`.
