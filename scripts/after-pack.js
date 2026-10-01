// Runs after electron-builder lays out the Windows app: stamps the Crave icon and version details into Crave.exe.
// (Done in JavaScript so the build doesn't need Wine on Linux or macOS.)
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(ctx){
  if (ctx.electronPlatformName !== "win32") return;
  const ResEdit = await import("resedit");
  const exePath = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const icoPath = path.join(ctx.packager.projectDir, "build", "icon.ico");
  const version = ctx.packager.appInfo.version;

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map(i => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split(".").map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const lang = { lang: 1033, codepage: 1200 };
  vi.setStringValues(lang, {
    ProductName: "Crave", FileDescription: "Crave video player", CompanyName: "Crave",
    InternalName: "Crave", OriginalFilename: "Crave.exe", LegalCopyright: "",
    FileVersion: version, ProductVersion: version
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • icon and version info written to ${path.basename(exePath)} (icon group ${target.id})`);
};
