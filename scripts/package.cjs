const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(__dirname, 'build-assets.cjs')], { stdio: 'inherit' });
const electronRoot = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
if (!fs.existsSync(path.join(electronRoot, 'electron.exe'))) throw new Error('请先运行 node node_modules/electron/install.js');
const out = path.join(root, 'dist', 'miniGPT-win32-x64');
fs.mkdirSync(out, { recursive: true });
fs.cpSync(electronRoot, out, { recursive: true });
const oldExe = path.join(out, 'electron.exe');
const targetExe = path.join(out, 'miniGPT.exe');
if (fs.existsSync(targetExe)) fs.unlinkSync(targetExe);
fs.renameSync(oldExe, targetExe);
const app = path.join(out, 'resources', 'app');
// Rebuild the application payload so removed features cannot survive in an old bundle.
if (fs.existsSync(app)) {
  const expected = path.join('dist', 'miniGPT-win32-x64', 'resources', 'app');
  if (path.relative(fs.realpathSync(root), fs.realpathSync(app)) !== expected) {
    throw new Error('Refusing to replace an application directory outside the package output.');
  }
  fs.rmSync(app, { recursive: true, force: true });
}
fs.mkdirSync(app, { recursive: true });
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'minigpt-desktop', productName: 'miniGPT', version: '0.1.0', main: 'src/main.cjs' }, null, 2));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, '使用说明.md'));
console.log(`可运行软件：${targetExe}`);
