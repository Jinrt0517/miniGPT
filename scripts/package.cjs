const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const metadata = require(path.join(root, 'package.json'));
execFileSync(process.execPath, [path.join(__dirname, 'build-assets.cjs')], { stdio: 'inherit' });
require('./build-native.cjs').buildNative();
const electronRoot = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
if (!fs.existsSync(path.join(electronRoot, 'electron.exe'))) throw new Error('请先运行 node node_modules/electron/install.js');
// Release builds use a separate directory so a running local copy stays usable.
const packageName = process.argv.includes('--release') ? `miniGPT-v${metadata.version}-win32-x64` : 'miniGPT-win32-x64';
if (!/^miniGPT-[A-Za-z0-9.-]+$/.test(packageName)) throw new Error('Invalid package directory name.');
const out = path.join(root, 'dist', packageName);
fs.mkdirSync(out, { recursive: true });
fs.cpSync(electronRoot, out, { recursive: true });
const oldExe = path.join(out, 'electron.exe');
const targetExe = path.join(out, 'miniGPT.exe');
if (fs.existsSync(targetExe)) fs.unlinkSync(targetExe);
fs.renameSync(oldExe, targetExe);
const app = path.join(out, 'resources', 'app');
// Rebuild the application payload so removed features cannot survive in an old bundle.
if (fs.existsSync(app)) {
  const expected = path.join('dist', packageName, 'resources', 'app');
  if (path.relative(fs.realpathSync(root), fs.realpathSync(app)) !== expected) {
    throw new Error('Refusing to replace an application directory outside the package output.');
  }
  fs.rmSync(app, { recursive: true, force: true });
}
fs.mkdirSync(app, { recursive: true });
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  description: metadata.description, repository: metadata.repository, homepage: metadata.homepage,
  bugs: metadata.bugs, main: metadata.main
}, null, 2));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, '使用说明.md'));
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(out, 'CHANGELOG.md'));
fs.cpSync(path.join(root, 'docs'), path.join(out, 'docs'), { recursive: true });
console.log(`可运行软件：${targetExe}`);
