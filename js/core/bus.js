/**
 * core/bus.js — tiny synchronous pub/sub.
 *
 * The only channel panels may use to talk to each other. No panel imports
 * another panel; they publish and subscribe here.
 *
 *   bus.on('table:changed', fn)   -> unsubscribe function
 *   bus.once('doc:added', fn)
 *   bus.emit('doc:added', payload)
 *   bus.on('*', (payload, event) => ...)   // firehose, for debugging
 */

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const channels = new Map();

  function on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('bus.on needs a handler');
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(handler);
    return () => off(event, handler);
  }

  function once(event, handler) {
    const stop = on(event, (payload, name) => {
      stop();
      handler(payload, name);
    });
    return stop;
  }

  function off(event, handler) {
    const set = channels.get(event);
    if (!set) return;
    set.delete(handler);
    if (!set.size) channels.delete(event);
  }

  function emit(event, payload) {
    const direct = channels.get(event);
    if (direct) {
      // copy so a handler unsubscribing mid-emit cannot skip a sibling
      for (const handler of [...direct]) {
        try {
          handler(payload, event);
        } catch (error) {
          console.error(`[bus] handler for "${event}" threw`, error);
        }
      }
    }
    const wild = channels.get('*');
    if (wild) {
      for (const handler of [...wild]) {
        try {
          handler(payload, event);
        } catch (error) {
          console.error('[bus] wildcard handler threw', error);
        }
      }
    }
  }

  function clear() {
    channels.clear();
  }

  return { on, once, off, emit, clear };
}

/** The single application bus. */
export const bus = createBus();

/**
 * Canonical event names. Strings are not enforced, but everything the shipped
 * UI emits is listed here so a new panel can discover the vocabulary.
 */
export const EVENTS = {
  FILES_CHANGED: 'files:changed',
  FILE_UPDATED: 'file:updated',
  DOC_ADDED: 'doc:added',
  DOC_REMOVED: 'doc:removed',
  DOCS_CHANGED: 'docs:changed',
  TABLE_CHANGED: 'table:changed',
  TABLE_SELECTION: 'table:selection',
  SETTINGS_CHANGED: 'settings:changed',
  EXTRACT_OPTS: 'extract:opts',
  TAB_CHANGED: 'shell:tab',
  NOTIFY: 'ui:notify',
  TASK_START: 'task:start',
  TASK_END: 'task:end'
};
