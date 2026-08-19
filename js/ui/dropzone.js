/**
 * ui/dropzone.js — file intake.
 *
 * States: idle · dragging · loading · done · error, reflected on
 * `[data-state]` so components.css owns the look.
 *
 * The zone is a real <button>, so it is keyboard reachable and announces
 * itself without any role juggling. Drag events are attached to the same
 * element plus a window-level guard so dropping outside never navigates the
 * browser away from the app.
 */

import { h, clear, badge, formatBytes } from './shell.js';
import { ACCEPT, ACCEPT_ATTR } from '../core/config.js';

let guardsInstalled = false;

function installWindowGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  // Prevent the browser from opening a file dropped anywhere else on the page.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (event) => {
      if (event.target.closest?.('.dropzone')) return;
      event.preventDefault();
    });
  }
}

/**
 * @param {{onFiles:(FileList|File[])=>void, multiple?:boolean, accept?:string,
 *          title?:string, hint?:string}} options
 */
export function createDropzone({
  onFiles,
  multiple = true,
  accept = ACCEPT_ATTR,
  title = 'Drop files here',
  hint = 'or press to choose. Nothing is uploaded — everything is read in this browser.'
} = {}) {
  installWindowGuards();

  const input = h('input', {
    type: 'file',
    accept,
    multiple,
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: () => {
      if (input.files?.length) onFiles(input.files);
      input.value = '';
    }
  });

  const titleEl = h('span', { class: 'dropzone-title' }, title);
  const hintEl = h('span', { class: 'dropzone-hint' }, hint);

  const formats = h(
    'span',
    { class: 'dropzone-formats' },
    ...Object.values(ACCEPT).map((group) =>
      badge(group.ext.map((e) => e.toUpperCase()).join(' · '), 'outline')
    )
  );

  const el = h(
    'button',
    {
      class: 'dropzone',
      type: 'button',
      dataset: { state: 'idle' },
      onclick: () => input.click()
    },
    input,
    titleEl,
    hintEl,
    formats
  );

  let dragDepth = 0;
  const setDragging = (on) => {
    if (el.dataset.state === 'loading') return;
    el.dataset.state = on ? 'dragging' : 'idle';
    titleEl.textContent = on ? 'Release to add' : title;
  };

  el.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  el.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  el.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  });
  el.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const files = event.dataTransfer?.files;
    if (files?.length) onFiles(files);
  });

  return {
    el,
    input,
    /** @param {'idle'|'dragging'|'loading'|'done'|'error'} state */
    setState(state, message) {
      el.dataset.state = state;
      el.disabled = state === 'loading';
      titleEl.textContent =
        message ||
        { idle: title, loading: 'Reading…', done: 'Add more files', error: 'That did not work' }[state] ||
        title;
      hintEl.textContent =
        state === 'error'
          ? 'Check the file type and try again.'
          : state === 'done'
            ? 'Drop more files to add them to the batch.'
            : hint;
      return state;
    },
    reset() {
      input.value = '';
      el.dataset.state = 'idle';
      el.disabled = false;
      titleEl.textContent = title;
      hintEl.textContent = hint;
    }
  };
}

const STATUS_TONE = {
  queued: 'outline',
  reading: 'info',
  done: 'ok',
  error: 'danger',
  cancelled: 'warn'
};

/**
 * The intake list: one row per file with type, size and page count.
 * @param {{onRemove:(id:string)=>void, onSelect?:(entry:object)=>void}} options
 */
export function createFileList({ onRemove, onSelect } = {}) {
  const list = h('div', { class: 'stack stack-sm' });

  function render(files, activeDocId) {
    clear(list);
    if (!files.length) {
      list.append(
        h('p', { class: 'field-hint' }, 'No files yet. Everything you add stays on this machine.')
      );
      return list;
    }

    for (const entry of files) {
      const meta = [
        entry.typeLabel,
        formatBytes(entry.size),
        entry.pageCount ? `${entry.pageCount} page${entry.pageCount === 1 ? '' : 's'}` : null
      ].filter(Boolean);

      const row = h(
        'div',
        {
          class: 'file-row',
          dataset: { status: entry.status },
          'aria-current': entry.docId && entry.docId === activeDocId ? 'true' : null
        },
        h('span', { class: 'file-kind', 'aria-hidden': 'true' }, (entry.ext || '?').slice(0, 4).toUpperCase()),
        h(
          'div',
          { style: { minWidth: '0' } },
          onSelect && entry.docId
            ? h(
                'button',
                {
                  class: 'file-name',
                  type: 'button',
                  style: { background: 'none', border: 0, padding: 0, textAlign: 'left', width: '100%' },
                  onclick: () => onSelect(entry)
                },
                entry.name
              )
            : h('div', { class: 'file-name', title: entry.name }, entry.name),
          h(
            'div',
            { class: 'file-meta' },
            ...meta.map((m) => h('span', null, m)),
            entry.error ? h('span', { class: 'text-danger' }, entry.error) : null
          )
        ),
        h(
          'div',
          { class: 'row row-tight' },
          badge(entry.status, STATUS_TONE[entry.status] || 'outline'),
          h(
            'button',
            {
              class: 'btn btn--ghost btn--sm btn--icon',
              type: 'button',
              'aria-label': `Remove ${entry.name}`,
              title: 'Remove',
              onclick: () => onRemove?.(entry.id)
            },
            '✕'
          )
        )
      );
      list.append(row);
    }
    return list;
  }

  return { el: list, render };
}
