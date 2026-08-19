/**
 * Trim / whitespace — group `clean`, order 20.
 *
 * The invisible-character pass matters more than it sounds: PDF and OCR output
 * is full of non-breaking spaces, zero-width joiners and soft hyphens that make
 * "Total assets" and "Total assets" compare unequal, which then breaks every
 * join, dedupe and header map downstream.
 */
import { buildTool, parseCsvText, rectangularise } from './_shared.js';

const INVISIBLE = /[ ­​‌‍⁠﻿]/g;

export const DEFAULTS = {
  trimEnds: true,
  collapseInner: true,
  stripInvisible: true,
  dropEmptyRows: true,
  dropEmptyCols: false,
  headerCase: 'off'
};

/** Pure: clean a single cell. */
export function cleanCell(value, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  let out = value === null || value === undefined ? '' : String(value);
  if (opts.stripInvisible) out = out.replace(INVISIBLE, (ch) => (ch === ' ' ? ' ' : ''));
  if (opts.collapseInner) out = out.replace(/\s+/g, ' ');
  if (opts.trimEnds) out = out.trim();
  return out;
}

export function toSnake(value) {
  return String(value || '')
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Pure: clean a whole grid.
 * @returns { rows, changed:Set<'r,c'>, changes:string[], removedRows:number, removedCols:string[] }
 */
export function trimGrid(grid, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const source = rectangularise(grid);
  const changed = new Set();
  const changes = [];

  let out = source.map((row, r) =>
    row.map((cell, c) => {
      const cleaned = cleanCell(cell, opts);
      if (cleaned !== String(cell)) {
        changed.add(`${r},${c}`);
        if (changes.length < 500) {
          changes.push(`row ${r} · col ${c + 1}: "${String(cell)}" -> "${cleaned}"`);
        }
      }
      return cleaned;
    })
  );

  if (opts.headerCase !== 'off' && out.length) {
    out[0] = out[0].map((cell, c) => {
      const next = opts.headerCase === 'snake' ? toSnake(cell) : String(cell).toLowerCase();
      if (next !== cell) {
        changed.add(`0,${c}`);
        changes.push(`header col ${c + 1}: "${cell}" -> "${next}"`);
      }
      return next;
    });
  }

  let removedRows = 0;
  if (opts.dropEmptyRows) {
    const kept = out.filter((row, index) => {
      if (index === 0) return true;
      const empty = row.every((cell) => cell === '');
      if (empty) removedRows += 1;
      return !empty;
    });
    if (removedRows) changes.push(`dropped ${removedRows} entirely empty row(s)`);
    out = kept;
  }

  const removedCols = [];
  if (opts.dropEmptyCols && out.length) {
    const width = out[0].length;
    const keep = [];
    for (let c = 0; c < width; c += 1) {
      const bodyEmpty = out.slice(1).every((row) => row[c] === '');
      const headEmpty = out[0][c] === '';
      if (bodyEmpty && headEmpty) removedCols.push(`col ${c + 1}`);
      else keep.push(c);
    }
    if (removedCols.length) {
      out = out.map((row) => keep.map((c) => row[c]));
      changes.push(`dropped ${removedCols.length} entirely empty column(s): ${removedCols.join(', ')}`);
    }
  }

  return { rows: rectangularise(out), changed, changes, removedRows, removedCols };
}

export const tool = {
  id: 'trim-whitespace',
  label: 'Trim & whitespace',
  group: 'clean',
  order: 20,
  description:
    'Trim ends, collapse runs of spaces, strip non-breaking and zero-width characters, and drop entirely empty rows or columns.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'trim-whitespace',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        { name: 'trimEnds', kind: 'checkbox', label: 'Trim leading/trailing whitespace', value: true },
        { name: 'collapseInner', kind: 'checkbox', label: 'Collapse runs of whitespace to one space', value: true },
        {
          name: 'stripInvisible',
          kind: 'checkbox',
          label: 'Strip zero-width / soft-hyphen characters, convert NBSP to a space',
          value: true
        },
        { name: 'dropEmptyRows', kind: 'checkbox', label: 'Drop entirely empty rows', value: true },
        { name: 'dropEmptyCols', kind: 'checkbox', label: 'Drop entirely empty columns', value: false },
        {
          name: 'headerCase',
          kind: 'select',
          label: 'Header case',
          value: 'off',
          options: [
            { value: 'off', label: 'Leave headers alone' },
            { value: 'lower', label: 'lowercase' },
            { value: 'snake', label: 'snake_case' }
          ]
        }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (!grid.length) return { summary: 'Paste a CSV to clean.' };
        const result = trimGrid(grid, values);
        const cells = result.changed.size;
        return {
          rows: result.rows,
          changed: result.changed,
          name: 'trimmed',
          summary: [
            `${result.rows.length - 1} data rows`,
            `${cells} cell(s) changed`,
            result.removedRows ? `${result.removedRows} empty row(s) dropped` : 'no rows dropped'
          ],
          changes: result.changes
        };
      }
    });
  }
};
