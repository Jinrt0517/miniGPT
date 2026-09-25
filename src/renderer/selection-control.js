/* A themed, keyboard-accessible listbox backed by the renderer's model options. */
(() => {
  'use strict';
  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${className}`);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  window.createSelectionControl = (select, { label, heading, iconName, shortLabel, width = 244 }) => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = `${select.id}-trigger`;
    trigger.className = 'selection-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${select.id}-listbox`);
    const value = document.createElement('span');
    value.className = 'selection-value';
    trigger.append(icon(iconName, 'selection-leading'), value, icon('chevron', 'selection-chevron'));

    const popup = document.createElement('div');
    popup.id = `${select.id}-popover`;
    popup.className = 'selection-popover';
    popup.setAttribute('popover', 'manual');
    const title = document.createElement('div');
    title.id = `${select.id}-heading`;
    title.className = 'selection-heading';
    title.textContent = heading;
    const list = document.createElement('div');
    list.id = `${select.id}-listbox`;
    list.className = 'selection-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-labelledby', title.id);
    list.tabIndex = -1;
    popup.append(title, list);
    select.parentElement.append(trigger, popup);
    let activeIndex = -1;
    let search = '', lastKeyTime = 0;
    const isOpen = () => popup.matches(':popover-open');

    function close(restoreFocus = false) {
      if (!isOpen()) return;
      popup.hidePopover();
      trigger.setAttribute('aria-expanded', 'false');
      list.removeAttribute('aria-activedescendant');
      if (restoreFocus && !trigger.disabled) trigger.focus({ preventScroll: true });
    }
    function sync() {
      const selected = select.selectedOptions[0];
      value.textContent = selected?.textContent || label;
      trigger.title = select.title || `${label}：${value.textContent}`;
      trigger.setAttribute('aria-label', `${label}：${value.textContent}`);
      trigger.disabled = select.disabled;
      if (trigger.disabled) close();
    }
    function activate(index) {
      const items = Array.from(list.children);
      activeIndex = Math.max(0, Math.min(index, items.length - 1));
      items.forEach((item, i) => item.classList.toggle('is-active', i === activeIndex));
      if (items[activeIndex]) {
        list.setAttribute('aria-activedescendant', items[activeIndex].id);
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    }
    function choose(index) {
      const option = select.options[index];
      if (!option || select.disabled || option.disabled) return;
      close(true);
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
    function open(edge) {
      if (select.disabled || !select.options.length) return;
      document.dispatchEvent(new CustomEvent('selection:opening', { detail: select.id }));
      list.replaceChildren();
      Array.from(select.options).forEach((option, index) => {
        const row = document.createElement('div');
        row.id = `${select.id}-option-${index}`;
        row.className = 'selection-option';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.selected));
        row.dataset.value = option.value;
        const name = document.createElement('span');
        name.className = 'selection-option-name';
        name.textContent = shortLabel?.(option) || option.textContent;
        row.append(name);
        row.append(icon('check', 'selection-check'));
        row.addEventListener('pointermove', () => activate(index));
        row.addEventListener('click', () => choose(index));
        list.append(row);
      });
      // Use the top layer so the menu remains visible above the compact composer.
      const anchor = trigger.getBoundingClientRect();
      const gap = 7, margin = 10;
      const above = anchor.top - gap - margin;
      const below = innerHeight - anchor.bottom - gap - margin;
      const opensAbove = above >= below;
      const available = Math.max(0, opensAbove ? above : below);
      popup.style.width = `${Math.min(width, innerWidth - 2 * margin)}px`;
      popup.style.maxHeight = `${available}px`;
      popup.showPopover();
      const bounds = popup.getBoundingClientRect();
      popup.style.left = `${Math.max(margin, Math.min(anchor.right - bounds.width, innerWidth - margin - bounds.width))}px`;
      popup.style.top = `${opensAbove ? Math.max(margin, anchor.top - gap - bounds.height) : anchor.bottom + gap}px`;
      popup.dataset.side = opensAbove ? 'above' : 'below';
      trigger.setAttribute('aria-expanded', 'true');
      search = '';
      list.focus({ preventScroll: true });
      activate(edge === 'first' ? 0 : edge === 'last' ? select.options.length - 1 : select.selectedIndex);
    }
    trigger.addEventListener('click', () => isOpen() ? close(true) : open());
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        open(event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined);
      }
    });
    list.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') close(true);
        else if (event.key === 'Enter' || event.key === ' ') choose(activeIndex);
        else activate(event.key === 'Home' ? 0 : event.key === 'End' ? select.options.length - 1 : activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Tab') {
        // Return to the trigger before the browser advances to its next tab stop.
        close(true);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        search = now - lastKeyTime > 700 ? event.key : search + event.key;
        lastKeyTime = now;
        const index = Array.from(select.options).findIndex(option => option.textContent.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        if (index >= 0) activate(index);
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener('focusin', event => {
      if (!popup.contains(event.target) && !trigger.contains(event.target)) close();
    });
    document.addEventListener('selection:opening', event => { if (event.detail !== select.id) close(); });
    window.addEventListener('resize', () => close());
    window.addEventListener('blur', () => close());
    sync();
    return { sync, close, isOpen };
  };
})();
