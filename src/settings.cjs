const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ hotkey: 'Alt+Space', hideOnBlur: false, alwaysOnTop: false,
  launchAtLogin: false, theme: 'system', followCursor: true, codexPath: '' });

function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式不正确');
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error('未知设置项');
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('设置值必须为开或关');
    } else if (typeof value !== 'string') throw new Error('设置值必须为文字');
    if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) throw new Error('未知主题');
    if (key === 'hotkey' && (!/^(?:(?:Alt|Control|Ctrl|Shift|Super|CommandOrControl)\+)+(?:Space|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(value) || value.length > 80)) {
      throw new Error('快捷键示例：Alt+Space 或 Control+Shift+Space');
    }
    if (key === 'codexPath' && value && (!path.isAbsolute(value) || !value.toLowerCase().endsWith('.exe'))) {
      throw new Error('请选择 Codex 可执行文件的完整 .exe 路径');
    }
    next[key] = value;
  }
  return next;
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.value = { ...DEFAULTS };
    try { this.value = { ...this.value, ...validateSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))) }; } catch {}
  }
  save(patch) {
    const value = { ...this.value, ...validateSettings(patch) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.value = value;
    return { ...value };
  }
}
module.exports = { DEFAULTS, validateSettings, SettingsStore };
