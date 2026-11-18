// Builds an unsigned macOS app zip on any OS, because electron-builder only builds macOS targets
// on a Mac. It downloads Electron's macOS zip and copies its entries into a new zip as raw data,
// which keeps the Unix modes and the framework symlinks (Windows zip tools drop both). It renames
// Electron.app to Marquee.app, rewrites Info.plist and the icon, and adds the files that
// build.files in package.json lists. Run `npm run vendor` first; `npm run dist:mac` does both.
//   node scripts/pack-mac.mjs [arm64|x64 ...]   (default: arm64 x64)
// The result isn't signed or notarized; see installers/mac/README.md for opening it on a Mac.
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const { downloadArtifact } = await import('@electron/get');
const NAME = pkg.build.productName;
const APP = `${NAME}.app/`;
const archs = process.argv.slice(2).length ? process.argv.slice(2) : ['arm64', 'x64'];

// --- zip reading -------------------------------------------------------------------------------
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 is not supported');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const e = {
      madeBy: buf.readUInt16LE(p + 4),
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      extAttr: buf.readUInt32LE(p + 38),
    };
    const nlen = buf.readUInt16LE(p + 28);
    e.name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lho = buf.readUInt32LE(p + 42);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    e.raw = buf.subarray(start, start + e.csize);
    entries.push(e);
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}
const inflate = (e) => (e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw));

// --- zip writing -------------------------------------------------------------------------------
function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const NOW = dosTime();
const UNIX = 3 << 8; // "version made by" host = Unix, so unzip and Archive Utility honour extAttr
function fileEntry(name, data, mode = 0o100644) {
  const raw = zlib.deflateRawSync(data, { level: 9 });
  return { name, method: 8, ...NOW, crc: zlib.crc32(data), csize: raw.length, usize: data.length, raw, madeBy: UNIX | 20, extAttr: (mode << 16) >>> 0 };
}
function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(e.method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.csize, 18);
    local.writeUInt32LE(e.usize, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.madeBy, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.csize, 20);
    cd.writeUInt32LE(e.usize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(e.extAttr, 38);
    cd.writeUInt32LE(offset, 42);
    chunks.push(local, name, e.raw);
    central.push(cd, name);
    offset += local.length + name.length + e.raw.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff || entries.length > 0xffff) throw new Error('zip too large for non-zip64');
  return Buffer.concat([...chunks, cdBuf, end]);
}

// --- app contents ------------------------------------------------------------------------------
function plistSet(xml, key, value) {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(xml)) return xml.replace(re, `$1${value}$2`);
  return xml.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${value}</string>`);
}
function infoPlist(xml) {
  if (!xml.startsWith('<?xml')) throw new Error('Info.plist is not XML');
  for (const [k, v] of Object.entries({
    CFBundleName: NAME,
    CFBundleDisplayName: NAME,
    CFBundleIdentifier: pkg.build.appId,
    CFBundleShortVersionString: pkg.version,
    CFBundleVersion: pkg.version,
  })) xml = plistSet(xml, k, v);
  return xml;
}

// An .icns can hold PNGs directly; macOS scales the 512 px one for the smaller sizes.
function icns(png) {
  const parts = ['ic09', 'ic14'].map((type) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + parts.reduce((n, b) => n + b.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}

// The files that build.files names: plain paths and "<dir>/**/*".
function appFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      statSync(full).isDirectory() ? walk(full) : out.push(relative(root, full).split(sep).join('/'));
    }
  };
  for (const pattern of pkg.build.files) {
    if (pattern.endsWith('/**/*')) walk(join(root, pattern.slice(0, -5)));
    else out.push(pattern);
  }
  if (!out.some((f) => f.startsWith('renderer/vendor/'))) throw new Error('renderer/vendor is missing; run npm run vendor');
  return out;
}

function packagedPackageJson() {
  // productName gives the app its name in the menu bar and its data folder, as on Windows.
  const { name, version, description, main, author } = pkg;
  return Buffer.from(JSON.stringify({ name, productName: NAME, version, description, main, author }, null, 2) + '\n');
}

// --- build -------------------------------------------------------------------------------------
mkdirSync(join(root, 'dist'), { recursive: true });
const icon = icns(readFileSync(join(root, 'build', 'icon.png')));
const files = appFiles();
for (const arch of archs) {
  const zipPath = await downloadArtifact({ version: electronVersion, artifactName: 'electron', platform: 'darwin', arch });
  const source = readZip(readFileSync(zipPath));
  const out = [];
  for (const e of source) {
    if (!e.name.startsWith('Electron.app/')) continue; // LICENSE files are added inside the app below
    const name = APP + e.name.slice('Electron.app/'.length);
    if (name === `${APP}Contents/Resources/default_app.asar`) continue;
    if (name === `${APP}Contents/Info.plist`) out.push(fileEntry(name, Buffer.from(infoPlist(inflate(e).toString('utf8')))));
    else if (name === `${APP}Contents/Resources/electron.icns`) out.push(fileEntry(name, icon));
    else out.push({ ...e, name });
  }
  const res = `${APP}Contents/Resources/`;
  for (const lic of ['LICENSE', 'LICENSES.chromium.html']) {
    const e = source.find((x) => x.name === lic);
    if (e) out.push(fileEntry(`${res}${lic}`, inflate(e)));
  }
  for (const f of files) {
    out.push(fileEntry(`${res}app/${f}`, f === 'package.json' ? packagedPackageJson() : readFileSync(join(root, f))));
  }
  const dest = join(root, 'dist', `${NAME}-${pkg.version}-mac-${arch}.zip`);
  writeFileSync(dest, writeZip(out));
  console.log(`pack-mac: ${relative(root, dest)} (${(statSync(dest).size / 1048576).toFixed(1)} MB, Electron ${electronVersion} ${arch})`);
}
