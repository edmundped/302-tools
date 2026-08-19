/**
 * ui/panel-tools.js — renders whatever the tool registry contains.
 *
 * This file knows nothing about any individual tool. It reads
 * `js/tools/index.js`, groups by `group`, sorts by `order`, and calls each
 * tool's own `mount(container, ctx)`. Adding a tool means adding a file and
 * registering it — this panel does not change.
 *
 *   register({ id, label, group, order, description, mount(container, ctx) })
 *   ctx = { store, bus, notify }
 */

import { h, clear, registerPanel, notify, emptyState, badge, setTabCount } from './shell.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { toolRegistry } from './deps.js';

/** Display order from docs/ARCHITECTURE.md § Tool registry. */
const GROUP_ORDER = ['clean', 'combine', 'convert', 'verify', 'annotate'];

const GROUP_BLURB = {
  clean: 'Get the values into a state you can trust.',
  combine: 'Put separate extractions together.',
  convert: 'Change the shape or the file format.',
  verify: 'Prove the numbers before they go anywhere.',
  annotate: 'Attach the context that has to travel with the data.'
};

function groupRank(name) {
  const index = GROUP_ORDER.indexOf(String(name || '').toLowerCase());
  return index === -1 ? GROUP_ORDER.length : index;
}

function mount(container, ctx) {
  const host = h('div', { class: 'stack stack-lg' });
  container.append(host);

  const toolCtx = { store, bus, notify };

  async function render() {
    clear(host);
    const { registry, stubbed } = await toolRegistry();

    if (stubbed || !registry.length) {
      host.append(
        emptyState({
          mark: '⚒',
          title: stubbed ? 'The tool registry has not landed yet' : 'No tools are registered',
          body: stubbed
            ? 'js/tools/index.js is not on disk. This panel renders whatever that registry exports — it holds no list of its own, so tools will appear here as soon as they are registered.'
            : 'js/tools/index.js exports an empty registry. Register a tool and it will appear here, in its group, without this panel changing.'
        })
      );
      setTabCount('tools', null);
      return;
    }

    const groups = new Map();
    for (const tool of registry) {
      if (!tool || typeof tool.mount !== 'function') {
        console.warn('[tools] skipping a registry entry without mount()', tool);
        continue;
      }
      const key = String(tool.group || 'other').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(tool);
    }

    const ordered = [...groups.entries()].sort(
      ([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b)
    );

    let count = 0;
    for (const [group, tools] of ordered) {
      tools.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.label).localeCompare(String(b.label)));

      const grid = h('div', { class: 'tool-grid' });
      for (const tool of tools) {
        count += 1;
        const body = h('div', { class: 'tool-mount' });
        const card = h(
          'section',
          { class: 'tool-card', id: `tool-${tool.id}`, 'aria-labelledby': `tool-${tool.id}-title` },
          h(
            'div',
            null,
            h('h3', { id: `tool-${tool.id}-title` }, tool.label || tool.id),
            tool.description ? h('p', null, tool.description) : null
          ),
          body
        );
        try {
          tool.mount(body, toolCtx);
        } catch (error) {
          console.error(`[tools] "${tool.id}" failed to mount`, error);
          clear(body).append(
            h('p', { class: 'text-danger', style: { fontSize: 'var(--fs-xs)' } }, `This tool failed to start: ${error.message}`)
          );
        }
        grid.append(card);
      }

      host.append(
        h(
          'section',
          { class: 'tool-group' },
          h(
            'header',
            { class: 'tool-group-head' },
            h('h2', null, group),
            badge(`${tools.length}`, 'outline'),
            h('p', null, GROUP_BLURB[group] || '')
          ),
          grid
        )
      );
    }

    setTabCount('tools', count || null);
  }

  render();

  if (ctx.head?.actions) {
    ctx.head.actions.append(
      h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onclick: render }, 'Reload tools')
    );
  }
}

registerPanel({
  id: 'tools',
  label: 'Tools',
  order: 30,
  eyebrow: 'the cleanup bench',
  title: 'Analyst tools',
  blurb:
    'Small, single-purpose utilities that work on tables you already have. Grouped by the job they do: clean, combine, convert, verify, annotate.',
  mount
});

export { mount };
