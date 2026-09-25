const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { validateWindowState, restoreWindowState, boundsOnDisplay, WindowStateStore, trackWindowState } = require('../src/window-state.cjs');

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { workArea: { x: -1280, y: 0, width: 1280, height: 984 } };

test('summoning on the same screen keeps the user placement instead of centering it', () => {
  const bounds = { x: 71, y: 123, width: 600, height: 480 };
  assert.deepEqual(boundsOnDisplay(bounds, primary), bounds);
});

test('following another screen preserves the relative placement and clamps only when needed', () => {
  const bounds = { x: 71, y: 123, width: 600, height: 480 };
  assert.deepEqual(boundsOnDisplay(bounds, primary, secondary), { ...bounds, x: -1209 });
  assert.deepEqual(boundsOnDisplay({ ...bounds, x: 1100, y: 550 }, primary, secondary), {
    x: -600, y: 504, width: 600, height: 480,
  });
});

test('saved position and size remain exact on the original display, including negative coordinates', () => {
  const state = { bounds: { x: -1190, y: 95, width: 720, height: 640 }, maximized: true };
  assert.deepEqual(restoreWindowState(state, [primary, secondary], primary), state);
});

test('removed displays and changed work areas restore a fully reachable window', () => {
  const state = { bounds: { x: -1190, y: 950, width: 2200, height: 1500 }, maximized: false };
  assert.deepEqual(restoreWindowState(state, [primary], primary), {
    bounds: { x: 0, y: 0, width: 1920, height: 1040 }, maximized: false
  });
  const tinyDisplay = { workArea: { x: 80, y: 30, width: 400, height: 240 } };
  assert.deepEqual(restoreWindowState({ bounds: { x: 4000, y: 3000, width: 20, height: 20 } }, [tinyDisplay], tinyDisplay), {
    bounds: { x: 80, y: 30, width: 400, height: 240 }, maximized: false
  });
});

test('malformed state is ignored instead of passing invalid bounds to Electron', () => {
  for (const state of [null, {}, { bounds: {} }, { bounds: { x: 0, y: 0, width: -3, height: 500 } },
    { bounds: { x: '0', y: 0, width: 600, height: 500 } }, { bounds: { x: Infinity, y: 0, width: 600, height: 500 } }]) {
    assert.equal(validateWindowState(state), null);
    assert.equal(restoreWindowState(state, [primary], primary), null);
  }
});

test('window state survives a new store and corrupt files fall back safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minigpt-window-state-'));
  try {
    const state = { bounds: { x: 130, y: 240, width: 750, height: 260 }, maximized: false };
    const store = new WindowStateStore(dir);
    store.save(state);
    assert.deepEqual(new WindowStateStore(dir).value, state);
    assert.equal(fs.existsSync(store.file + '.tmp'), false);
    fs.writeFileSync(store.file, '{ invalid json');
    assert.equal(new WindowStateStore(dir).value, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

class TestWindow extends EventEmitter {
  bounds = { x: 130, y: 240, width: 750, height: 480 };
  maximized = false;
  minimized = false;
  isDestroyed() { return false; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  getBounds() { return { ...this.bounds }; }
}

test('moves are debounced and closing flushes the latest normal bounds immediately', async () => {
  const window = new TestWindow();
  const values = [];
  trackWindowState(window, { save: value => values.push(value) }, { delay: 10 });
  window.emit('move');
  window.bounds.x = 310;
  window.emit('move');
  await wait(30);
  assert.equal(values.length, 1);
  assert.equal(values[0].bounds.x, 310);
  window.bounds.height = 260;
  window.emit('resize');
  window.emit('close');
  assert.equal(values.length, 2);
  assert.equal(values[1].bounds.height, 260);
  await wait(30);
  assert.equal(values.length, 2);
});

test('minimizing preserves the previous maximized state and normal restore bounds', () => {
  const window = new TestWindow();
  const values = [];
  const tracker = trackWindowState(window, { save: value => values.push(value) });
  window.maximized = true;
  window.emit('maximize');
  window.minimized = true;
  window.maximized = false;
  tracker.save();
  assert.deepEqual(values.at(-1), { bounds: window.bounds, maximized: true });
  window.minimized = false;
  window.emit('unmaximize');
  assert.equal(values.at(-1).maximized, false);
});

test('a deferred maximized restore remains persisted while the startup window is hidden', () => {
  const window = new TestWindow();
  const values = [];
  const tracker = trackWindowState(window, { save: value => values.push(value) }, { isMaximized: () => true });
  tracker.save();
  assert.equal(values[0].maximized, true);
});
