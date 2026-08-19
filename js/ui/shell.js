/**
 * ui/shell.js — the application shell.
 *
 * Owns: DOM helpers, the panel registry, tab routing (with ARIA + keyboard),
 * lazy panel mounting, and the toast host.
 *
 * A panel registers itself at import time:
 *
 *   import { registerPanel } from './shell.js';
 *   registerPanel({ id, label, order, title, blurb, mount(container, ctx) });
 *
 * Adding a panel therefore never requires editing this file.
 */

import { bus, EVENTS } from '../core/bus.js';

/* =========================================================== DOM helpers  */

const BOOLEAN_PROPS = new Set([
  'disabled', 'checked', 'selected', 'hidden', 'multiple', 'readOnly', 'required', 'open'
]);

/**
 * Create an element.
 *   h('button', { class: 'btn', onclick: fn }, 'Label')
 * `html:` is accepted only for markup this module authors — never for
 * user or document content. Use text nodes for anything from a file.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || Array.isArray(props) || props instanceof Node)) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (BOOLEAN_PROPS.has(key)) {
      el[key] = !!value;
    } else if (key === 'value' || key === 'contentEditable') {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendAll(el, children);
  return el;
}

export function appendAll(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function frag(...children) {
  return appendAll(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function badge(text, tone, title) {
  return h('span', { class: `badge${tone ? ` badge--${tone}` : ''}`, title: title || null }, text);
}

export function emptyState({ mark = '·', title, body, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-mark', 'aria-hidden': 'true' }, mark),
    h('h3', null, title),
    body ? h('p', null, body) : null,
    action || null
  );
}

/* ========================================================= panel registry */

/** @type {Map<string, object>} */
const panels = new Map();
let shellState = null;

/**
 * @param {{id:string,label:string,order?:number,title?:string,blurb?:string,
 *          mount:(container:HTMLElement, ctx:object)=>void}} def
 */
export function registerPanel(def) {
  if (!def || !def.id) throw new Error('registerPanel needs an id');
  if (typeof def.mount !== 'function') throw new Error(`panel "${def.id}" needs mount()`);
  if (panels.has(def.id)) {
    console.warn(`[shell] panel "${def.id}" registered twice — the later one wins`);
  }
  panels.set(def.id, { order: 100, ...def, mounted: false });
  // If the shell is already running, splice the new panel in live.
  if (shellState) renderTabs();
  return def.id;
}

export function listPanels() {
  return [...panels.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/* =============================================================== toasts   */

let toastHost = null;

export function notify(message, tone = 'info', timeout = 5200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const toast = h(
    'div',
    { class: 'toast', dataset: { tone } },
    h('span', { style: { flex: '1 1 auto' } }, message),
    h('button', {
      class: 'btn btn--ghost btn--sm btn--icon',
      type: 'button',
      'aria-label': 'Dismiss',
      onclick: () => toast.remove()
    }, '✕')
  );
  toastHost.append(toast);
  if (timeout) setTimeout(() => toast.remove(), timeout);
  return toast;
}

/* ================================================================ shell   */

function renderTabs() {
  const { tablist, main, ctx } = shellState;
  const ordered = listPanels();
  clear(tablist);

  for (const panel of ordered) {
    const tabId = `tab-${panel.id}`;
    const panelId = `panel-${panel.id}`;

    if (!panel.section) {
      panel.section = h('section', {
        class: 'panel',
        id: panelId,
        role: 'tabpanel',
        tabindex: '0',
        'aria-labelledby': tabId,
        hidden: true
      });
      main.append(panel.section);
    }

    const count = h('span', { class: 'tab-count', 'aria-hidden': 'true' });
    if (panel.count) count.textContent = panel.count;

    const tab = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        id: tabId,
        role: 'tab',
        'aria-controls': panelId,
        'aria-selected': String(shellState.active === panel.id),
        tabindex: shellState.active === panel.id ? '0' : '-1',
        dataset: { panel: panel.id },
        onclick: () => activate(panel.id)
      },
      h('span', null, panel.label),
      count
    );
    panel.tab = tab;
    panel.countEl = count;
    tablist.append(tab);
  }

  tablist.onkeydown = onTabKeydown;
  if (shellState.active) applyActive(shellState.active, false);
  return ordered;
}

function onTabKeydown(event) {
  const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const tabs = [...shellState.tablist.querySelectorAll('[role="tab"]')];
  const current = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  let next = current;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  event.preventDefault();
  const target = tabs[next];
  if (target) {
    activate(target.dataset.panel);
    target.focus();
  }
}

function applyActive(id, updateHash = true) {
  for (const panel of panels.values()) {
    const isActive = panel.id === id;
    if (panel.tab) {
      panel.tab.setAttribute('aria-selected', String(isActive));
      panel.tab.tabIndex = isActive ? 0 : -1;
    }
    if (panel.section) {
      panel.section.classList.toggle('is-active', isActive);
      panel.section.hidden = !isActive;
    }
  }
  if (updateHash && location.hash.slice(1) !== id) {
    history.replaceState(null, '', `#${id}`);
  }
}

/** Switch to a panel, mounting it on first visit. */
export function activate(id) {
  if (!shellState) return;
  const panel = panels.get(id) || listPanels()[0];
  if (!panel) return;

  shellState.active = panel.id;
  applyActive(panel.id);

  if (!panel.mounted) {
    panel.mounted = true;
    const container = clear(panel.section);
    try {
      const head = panelHead(panel);
      if (head) container.append(head);
      const body = h('div', { class: 'panel-body' });
      container.append(body);
      panel.mount(body, { ...shellState.ctx, panel: panel.id, head });
    } catch (error) {
      console.error(`[shell] panel "${panel.id}" failed to mount`, error);
      container.append(
        emptyState({
          mark: '!',
          title: 'This panel could not start',
          body: error.message
        })
      );
    }
  }

  shellState.ctx.store.setUi({ tab: panel.id });
  bus.emit(EVENTS.TAB_CHANGED, { id: panel.id });
}

function panelHead(panel) {
  if (!panel.title && !panel.blurb) return null;
  const actions = h('div', { class: 'panel-actions' });
  const head = h(
    'header',
    { class: 'panel-head' },
    h(
      'div',
      { style: { minWidth: '0' } },
      panel.eyebrow ? h('p', { class: 'eyebrow' }, panel.eyebrow) : null,
      panel.title ? h('h1', null, panel.title) : null,
      panel.blurb ? h('p', null, panel.blurb) : null
    ),
    actions
  );
  head.actions = actions;
  return head;
}

/** Update the small count pill on a tab. Pass null to clear it. */
export function setTabCount(id, count) {
  const panel = panels.get(id);
  if (!panel) return;
  panel.count = count;
  if (panel.countEl) panel.countEl.textContent = count ? String(count) : '';
}

/**
 * Boot the shell.
 * @param {{tablist:HTMLElement, main:HTMLElement, ctx:object, fallback?:string}} options
 */
export function startShell({ tablist, main, ctx, fallback }) {
  shellState = { tablist, main, ctx, active: null };
  const ordered = renderTabs();
  if (!ordered.length) {
    main.append(
      emptyState({ mark: '∅', title: 'No panels registered', body: 'The shell started but nothing registered itself.' })
    );
    return;
  }
  const fromHash = location.hash.slice(1);
  const initial = panels.has(fromHash) ? fromHash : fallback && panels.has(fallback) ? fallback : ordered[0].id;
  activate(initial);

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (panels.has(id) && id !== shellState.active) activate(id);
  });

  return { activate, setTabCount };
}

export const shell = { registerPanel, startShell, activate, setTabCount, listPanels, notify };
