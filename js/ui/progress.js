/**
 * ui/progress.js — determinate progress with a Cancel button that actually
 * cancels.
 *
 * Contract (docs/ARCHITECTURE.md § Ingest registry):
 *   onProgress({ phase, current, total, message })
 *   cancellation via opts.signal (AbortSignal)
 *
 * Every long task in this app runs through `runTask`, which owns the
 * AbortController so no panel has to remember to make one.
 */

import { h, clear } from './shell.js';
import { bus, EVENTS } from '../core/bus.js';

const PHASE_LABEL = {
  read: 'Reading',
  parse: 'Parsing',
  render: 'Rendering',
  ocr: 'OCR',
  tables: 'Tables',
  classify: 'Classifying',
  emit: 'Writing',
  fetch: 'Fetching',
  done: 'Done'
};

/**
 * A progress card. Not mounted anywhere by itself — the caller places `.el`.
 * @param {{label?:string, onCancel?:Function, cancellable?:boolean}} options
 */
export function createProgress({ label = 'Working…', onCancel, cancellable = true } = {}) {
  const labelEl = h('span', { class: 'progress-label' }, label);
  const phaseEl = h('span', { class: 'progress-phase' });
  const countEl = h('span', { class: 'progress-count' });
  const fillEl = h('div', { class: 'progress-fill' });
  const messageEl = h('p', { class: 'progress-message' });

  const cancelBtn = h(
    'button',
    {
      class: 'btn btn--secondary btn--sm',
      type: 'button',
      onclick: () => {
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelling…';
        onCancel?.();
      }
    },
    'Cancel'
  );

  const track = h(
    'div',
    {
      class: 'progress-track',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'aria-label': label
    },
    fillEl
  );

  const el = h(
    'section',
    { class: 'progress', dataset: { state: 'indeterminate' }, 'aria-live': 'polite' },
    h(
      'div',
      { class: 'progress-top' },
      labelEl,
      phaseEl,
      h('span', { class: 'push' }),
      countEl,
      cancellable ? cancelBtn : null
    ),
    track,
    messageEl
  );

  const api = {
    el,
    /** @param {{phase?:string,current?:number,total?:number,message?:string}} p */
    set(p = {}) {
      const { phase, current, total, message } = p;
      if (phase) phaseEl.textContent = PHASE_LABEL[phase] || phase;
      if (typeof total === 'number' && total > 0 && typeof current === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
        el.dataset.state = 'running';
        fillEl.style.width = `${pct}%`;
        countEl.textContent = `${current} / ${total}`;
        track.setAttribute('aria-valuenow', String(pct));
        track.setAttribute('aria-valuetext', `${pct}% — ${message || phase || ''}`.trim());
      } else if (el.dataset.state === 'running' || el.dataset.state === 'indeterminate') {
        el.dataset.state = 'indeterminate';
        track.removeAttribute('aria-valuenow');
      }
      if (message !== undefined) messageEl.textContent = message || '';
      return api;
    },
    setLabel(text) {
      labelEl.textContent = text;
      track.setAttribute('aria-label', text);
      return api;
    },
    /** 'indeterminate' | 'running' | 'done' | 'error' | 'cancelled' */
    setState(state, message) {
      el.dataset.state = state;
      if (state === 'done') {
        fillEl.style.width = '100%';
        track.setAttribute('aria-valuenow', '100');
      }
      if (state !== 'running' && state !== 'indeterminate') {
        cancelBtn.remove();
        phaseEl.textContent = '';
      }
      if (message !== undefined) messageEl.textContent = message;
      return api;
    },
    remove() {
      el.remove();
      return api;
    }
  };

  return api;
}

/**
 * Run a cancellable task, showing progress in `host`.
 *
 * @param {HTMLElement} host        where the progress card is placed
 * @param {object} options
 * @param {string} options.label
 * @param {(onProgress:Function, signal:AbortSignal)=>Promise<any>} options.run
 * @param {boolean} [options.keepOnSuccess]  leave the card visible when done
 * @returns {Promise<{ok:boolean, value?:any, cancelled?:boolean, error?:Error}>}
 */
export async function runTask(host, { label, run, keepOnSuccess = false }) {
  const controller = new AbortController();
  const progress = createProgress({ label, onCancel: () => controller.abort() });
  host.append(progress.el);
  bus.emit(EVENTS.TASK_START, { label });

  const onProgress = (payload) => progress.set(payload || {});

  try {
    const value = await run(onProgress, controller.signal);
    if (keepOnSuccess) progress.setState('done', 'Finished.');
    else progress.remove();
    return { ok: true, value };
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      progress.setState('cancelled', 'Cancelled. Nothing was written.');
      setTimeout(() => progress.remove(), 2600);
      return { ok: false, cancelled: true };
    }
    console.error('[task] failed', error);
    progress.setState('error', error?.message || 'Something went wrong.');
    return { ok: false, error };
  } finally {
    bus.emit(EVENTS.TASK_END, { label });
  }
}

/**
 * Run several tasks in sequence behind one progress card — the "then many"
 * half of "one, then many". Each item gets its own AbortSignal check.
 *
 * @param {HTMLElement} host
 * @param {{label:string, items:any[], each:(item:any, onProgress:Function, signal:AbortSignal, index:number)=>Promise<any>, describe?:(item:any)=>string}} options
 */
export async function runBatch(host, { label, items, each, describe = String }) {
  const controller = new AbortController();
  const progress = createProgress({ label, onCancel: () => controller.abort() });
  host.append(progress.el);
  bus.emit(EVENTS.TASK_START, { label });

  const results = [];
  let cancelled = false;

  try {
    for (let i = 0; i < items.length; i += 1) {
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      const item = items[i];
      progress.setLabel(`${label} — ${describe(item)}`);
      progress.set({ current: i, total: items.length, phase: 'read', message: describe(item) });
      const inner = (payload = {}) => {
        // blend the per-item progress into the overall bar
        const share = payload.total ? (payload.current || 0) / payload.total : 0;
        progress.set({
          phase: payload.phase,
          current: Math.round((i + share) * 100) / 100,
          total: items.length,
          message: payload.message
        });
      };
      try {
        results.push({ item, ok: true, value: await each(item, inner, controller.signal, i) });
      } catch (error) {
        if (error?.name === 'AbortError') {
          cancelled = true;
          break;
        }
        results.push({ item, ok: false, error });
      }
    }
    if (cancelled) {
      progress.setState('cancelled', `Cancelled after ${results.length} of ${items.length}.`);
      setTimeout(() => progress.remove(), 2600);
    } else {
      progress.remove();
    }
    return { results, cancelled };
  } finally {
    bus.emit(EVENTS.TASK_END, { label });
  }
}

/** A small inline "busy" strip for short work that has no page count. */
export function busyStrip(message = 'Working…') {
  return h('p', { class: 'status-line row' }, h('span', { class: 'spinner' }), message);
}

export { clear };
