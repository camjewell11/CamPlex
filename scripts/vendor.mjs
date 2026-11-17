// Copies the browser files the renderer needs from node_modules into renderer/vendor, so the
// packaged app ships those files and no node_modules. Runs before start and dist.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'renderer', 'vendor');
const mod = (...p) => join(root, 'node_modules', ...p);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'font', 'files'), { recursive: true });
copyFileSync(mod('dashjs', 'dist', 'legacy', 'umd', 'dash.all.min.js'), join(out, 'dash.all.min.js'));

// standard.css names its font files with relative URLs; copy the CSS and the files it names.
const fontDir = mod('@fontsource-variable', 'bricolage-grotesque');
const css = readFileSync(join(fontDir, 'standard.css'), 'utf8');
copyFileSync(join(fontDir, 'standard.css'), join(out, 'font', 'standard.css'));
const names = [...css.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map((m) => m[1]);
for (const name of names) copyFileSync(join(fontDir, 'files', name), join(out, 'font', 'files', name));
if (!names.length || !readdirSync(join(out, 'font', 'files')).length) throw new Error('No font files found in standard.css');
console.log(`vendor: dash.js and ${names.length} font files copied to renderer/vendor`);
