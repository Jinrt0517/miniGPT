const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buildNative() {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'src', 'native', 'windows-taskbar.cs');
  const executable = path.join(root, 'assets', 'windows-taskbar.exe');
  if (process.platform !== 'win32') return null;
  if (fs.existsSync(executable) && fs.statSync(executable).mtimeMs >= fs.statSync(source).mtimeMs) return executable;

  const windows = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(folder => path.join(windows, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('Windows taskbar helper requires the .NET Framework C# compiler (csc.exe).');

  fs.mkdirSync(path.dirname(executable), { recursive: true });
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', `/out:${executable}`, source], {
    windowsHide: true,
    stdio: 'pipe',
    timeout: 30000
  });
  if (!fs.existsSync(executable)) throw new Error('Windows taskbar helper compilation produced no executable.');
  return executable;
}

module.exports = { buildNative };

if (require.main === module) {
  try {
    const executable = buildNative();
    if (executable) console.log(`Windows taskbar helper prepared: ${executable}`);
  } catch (error) {
    console.error(error.stdout?.toString().trim() || error.message);
    process.exitCode = 1;
  }
}
