const fs = require('node:fs');
const path = require('node:path');

const MIN_WINDOW_SIZE = Object.freeze({ width: 480, height: 260 });

function validateWindowState(value) {
  const bounds = value?.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) ||
      bounds.width <= 0 || bounds.height <= 0) return null;
  return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized: value.maximized === true };
}

function restoreWindowState(value, displays, primaryDisplay) {
  const state = validateWindowState(value);
  if (!state || !displays.length) return null;
  const bounds = state.bounds;
  let display = primaryDisplay || displays[0], greatestOverlap = 0;
  for (const candidate of displays) {
    const area = candidate.workArea;
    const overlap = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) *
      Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    if (overlap > greatestOverlap) { greatestOverlap = overlap; display = candidate; }
  }
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(MIN_WINDOW_SIZE.width, bounds.width));
  const height = Math.min(area.height, Math.max(MIN_WINDOW_SIZE.height, bounds.height));
  return { bounds: {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width, height
  }, maximized: state.maximized };
}

function setWindowBounds(window, bounds) {
  const current = window.getBounds();
  if (Object.keys(bounds).every(key => current[key] === bounds[key])) return;
  const requested = { ...bounds };
  // Windows can round frameless bounds outwards at fractional display scaling.
  // Correct the reported result instead of adding those extra pixels on every launch.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested);
    const actual = window.getBounds();
    if (Object.keys(requested).every(key => actual[key] === bounds[key])) break;
    for (const key of Object.keys(requested)) requested[key] += bounds[key] - actual[key];
  }
}

function boundsOnDisplay(bounds, currentDisplay, targetDisplay = currentDisplay) {
  const source = currentDisplay.workArea, target = targetDisplay.workArea;
  const translated = { ...bounds,
    x: bounds.x + target.x - source.x,
    y: bounds.y + target.y - source.y,
  };
  return restoreWindowState({ bounds: translated }, [targetDisplay], targetDisplay).bounds;
}

class WindowStateStore {
  constructor(dir) {
    this.file = path.join(dir, 'window-state.json');
    this.value = null;
    try { this.value = validateWindowState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
  }
  save(value) {
    const state = validateWindowState(value);
    if (!state) return;
    if (JSON.stringify(state) === JSON.stringify(this.value)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
    this.value = state;
  }
}

function trackWindowState(window, store, { delay = 200, isMaximized = () => window.isMaximized() } = {}) {
  let timer;
  let maximized = store.value?.maximized ?? false;
  let normalBounds = window.getBounds();
  const capture = () => {
    if (window.isDestroyed()) return false;
    // A minimized window can report false even when it was maximized before minimizing.
    if (!window.isMinimized()) {
      maximized = isMaximized();
      // Keep the last normal rectangle through minimize/maximize transitions.
      if (!maximized) normalBounds = window.getBounds();
    }
    return true;
  };
  const save = () => {
    clearTimeout(timer);
    if (!capture()) return;
    try { store.save({ bounds: normalBounds, maximized }); }
    catch (error) { console.warn('Unable to save window position:', error.message); }
  };
  const schedule = () => { capture(); clearTimeout(timer); timer = setTimeout(save, delay); };
  for (const event of ['move', 'resize']) window.on(event, schedule);
  for (const event of ['maximize', 'unmaximize', 'hide', 'close', 'session-end']) window.on(event, save);
  window.once('closed', () => clearTimeout(timer));
  return { save };
}

module.exports = { MIN_WINDOW_SIZE, validateWindowState, restoreWindowState, setWindowBounds, boundsOnDisplay, WindowStateStore, trackWindowState };
