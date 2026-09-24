const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateSettings, SettingsStore } = require('../src/settings.cjs');
test('reject malformed shortcuts and executable paths', () => {
  assert.throws(() => validateSettings({ hotkey: 'Space' }));
  assert.throws(() => validateSettings({ hotkey: 'Alt+Space;bad' }));
  assert.throws(() => validateSettings({ codexPath: 'cmd /c hello' }));
  assert.throws(() => validateSettings({ unknown: true }));
  assert.deepEqual(validateSettings({ hotkey: 'Control+Shift+Space' }), { hotkey: 'Control+Shift+Space' });
});
test('settings persist safely and invalid stored data restores defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigpt-settings-'));
  try {
    const store = new SettingsStore(dir);
    store.save({ alwaysOnTop: true, theme: 'dark' });
    assert.equal(new SettingsStore(dir).value.theme, 'dark');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ invalid json');
    assert.equal(new SettingsStore(dir).value.theme, 'system');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
