// Renders build/icon.svg to build/icon.png (512 px), which electron-builder turns into the .ico.
// Run with Electron: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SIZE = 512;
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).resize({ width: SIZE, height: SIZE }).toPNG();
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
  console.log(`wrote build/icon.png (${png.length} bytes)`);
  app.quit();
});
