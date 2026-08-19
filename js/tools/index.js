/**
 * js/tools/index.js — the tool registry.
 *
 * Contract (docs/ARCHITECTURE.md):
 *
 *   register({ id, label, group, order, description, mount(container, ctx) })
 *
 *   ctx = { store, bus, notify }
 *
 * Groups render in this fixed order:  clean -> combine -> convert -> verify -> annotate
 *
 * The UI does not know the tool list. It calls getGroups() and renders whatever
 * comes back, so ordering and grouping live here.
 *
 * Adding a tool: create js/tools/<id>.js exporting `tool`, then add it to
 * TOOL_MODULES below. Tool modules export a descriptor rather than importing
 * `register` themselves — that keeps the dependency one-way and avoids the
 * circular-import TDZ trap you get when modules register themselves into their
 * own index.
 */

export const GROUPS = [
  {
    id: 'clean',
    label: 'Clean',
    description: 'Fix the cells before you do anything else with them.'
  },
  {
    id: 'combine',
    label: 'Combine',
    description: 'Put two or more tables together without losing columns.'
  },
  {
    id: 'convert',
    label: 'Convert',
    description: 'Change the file format or the shape of the table.'
  },
  {
    id: 'verify',
    label: 'Verify',
    description: 'Check the numbers and the structure before you publish them.'
  },
  {
    id: 'annotate',
    label: 'Annotate',
    description: 'Add the provenance and the canonical names an analyst needs.'
  }
];

const GROUP_ORDER = new Map(GROUPS.map((group, index) => [group.id, index]));

const registry = new Map();

export function register(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('register(): a tool descriptor is required.');
  const required = ['id', 'label', 'group', 'mount'];
  required.forEach((key) => {
    if (!tool[key]) throw new Error(`register(): tool is missing "${key}".`);
  });
  if (typeof tool.mount !== 'function') throw new Error(`register(${tool.id}): mount must be a function.`);
  if (!GROUP_ORDER.has(tool.group)) {
    throw new Error(
      `register(${tool.id}): unknown group "${tool.group}". Use one of ${GROUPS.map((g) => g.id).join(', ')}.`
    );
  }
  if (registry.has(tool.id)) throw new Error(`register(${tool.id}): duplicate tool id.`);

  registry.set(tool.id, {
    id: tool.id,
    label: tool.label,
    group: tool.group,
    order: Number.isFinite(tool.order) ? tool.order : 999,
    description: tool.description || '',
    mount: tool.mount
  });
  return tool.id;
}

function compare(a, b) {
  const groupDelta = GROUP_ORDER.get(a.group) - GROUP_ORDER.get(b.group);
  if (groupDelta !== 0) return groupDelta;
  if (a.order !== b.order) return a.order - b.order;
  return a.label.localeCompare(b.label);
}

/** Every registered tool, in display order. */
export function getTools() {
  return Array.from(registry.values()).sort(compare);
}

export function getTool(id) {
  return registry.get(id) || null;
}

/** Tools bucketed into their groups, groups in display order, empty groups dropped. */
export function getGroups() {
  const tools = getTools();
  return GROUPS.map((group) => ({
    ...group,
    tools: tools.filter((tool) => tool.group === group.id)
  })).filter((group) => group.tools.length);
}

/** Convenience for the panel: mount by id with a guard so one bad tool cannot blank the tab. */
export function mountTool(id, container, ctx) {
  const tool = getTool(id);
  if (!tool) throw new Error(`No tool registered with id "${id}".`);
  try {
    tool.mount(container, ctx || {});
  } catch (err) {
    container.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'danger';
    message.textContent = `${tool.label} failed to load: ${err.message}`;
    container.appendChild(message);
  }
  return tool;
}

/* ------------------------------------------------------------------ *
 * Registration. Order within a group comes from each tool's `order`,
 * not from this list, but the list is kept in display order for readability.
 * ------------------------------------------------------------------ */
import { tool as numberClean } from './number-clean.js';
import { tool as trimWhitespace } from './trim-whitespace.js';
import { tool as dedupeRows } from './dedupe-rows.js';
import { tool as transpose } from './transpose.js';

import { tool as mergeCsv } from './merge-csv.js';
import { tool as joinCsv } from './join-csv.js';

import { tool as csvExcel } from './csv-excel.js';
import { tool as reshape } from './reshape.js';

import { tool as footCheck } from './foot-check.js';
import { tool as schemaCheck } from './schema-check.js';

import { tool as provenance } from './provenance.js';
import { tool as headerMap } from './header-map.js';

[
  numberClean,
  trimWhitespace,
  dedupeRows,
  transpose,
  mergeCsv,
  joinCsv,
  csvExcel,
  reshape,
  footCheck,
  schemaCheck,
  provenance,
  headerMap
].forEach(register);
