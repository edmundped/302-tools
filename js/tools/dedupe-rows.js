/**
 * Dedupe rows — group `clean`, order 30.
 *
 * Two modes on purpose. "Remove" is what you want on a merged extract; "flag"
 * is what you want when you do not yet trust that the duplicates really are
 * duplicates, which on scraped and OCR'd data is most of the time.
 */
import { buildTool, parseCsvText, rectangularise, normaliseKey, indexOfHeader } from './_shared.js';

/** Pure: build the comparison key for one row. */
export function rowKey(row, keyColumns, options) {
  const opts = options || {};
  const cols = keyColumns && keyColumns.length ? keyColumns : row.map((_, i) => i);
  return cols
    .map((c) => {
      let cell = row[c] === undefined || row[c] === null ? '' : String(row[c]);
      if (opts.ignoreWhitespace) cell = cell.replace(/\s+/g, ' ').trim();
      if (opts.loose) return normaliseKey(cell);
      if (opts.ignoreCase) cell = cell.toLowerCase();
      return cell;
    })
    .join('');
}

/**
 * Pure.
 * @param grid    string[][] with a header row
 * @param options { keyColumns:number[]|null, ignoreCase, ignoreWhitespace, loose, keep:'first'|'last', mode:'remove'|'flag' }
 * @returns { rows, removed:[{index,row,firstSeen}], changes:string[], duplicateGroups:number }
 */
export function dedupeGrid(grid, options) {
  const opts = { keep: 'first', mode: 'remove', ...(options || {}) };
  const source = rectangularise(grid);
  if (source.length < 2) return { rows: source, removed: [], changes: [], duplicateGroups: 0 };

  const header = source[0];
  const body = source.slice(1);
  const seen = new Map(); // key -> first body index
  const dupOf = new Array(body.length).fill(-1);
  const counts = new Map();

  body.forEach((row, index) => {
    const key = rowKey(row, opts.keyColumns, opts);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (seen.has(key)) dupOf[index] = seen.get(key);
    else seen.set(key, index);
  });

  const duplicateGroups = Array.from(counts.values()).filter((n) => n > 1).length;

  if (opts.mode === 'flag') {
    const rows = [header.concat(['duplicate_of_row'])];
    body.forEach((row, index) => {
      rows.push(row.concat([dupOf[index] === -1 ? '' : String(dupOf[index] + 1)]));
    });
    const changes = dupOf
      .map((first, index) => (first === -1 ? null : `row ${index + 1} duplicates row ${first + 1}`))
      .filter(Boolean);
    return {
      rows: rectangularise(rows),
      removed: [],
      changes: changes.length ? changes : [],
      duplicateGroups,
      flaggedColumn: header.length
    };
  }

  // remove mode
  const keepIndex = new Map(); // key -> body index we keep
  body.forEach((row, index) => {
    const key = rowKey(row, opts.keyColumns, opts);
    if (!keepIndex.has(key) || opts.keep === 'last') keepIndex.set(key, index);
  });
  const kept = new Set(keepIndex.values());

  const rows = [header];
  const removed = [];
  body.forEach((row, index) => {
    if (kept.has(index)) rows.push(row);
    else removed.push({ index: index + 1, row, firstSeen: (dupOf[index] === -1 ? index : dupOf[index]) + 1 });
  });

  const changes = removed.map(
    (entry) => `removed row ${entry.index} (duplicate of row ${entry.firstSeen}): ${entry.row.slice(0, 4).join(' | ')}`
  );

  return { rows: rectangularise(rows), removed, changes, duplicateGroups };
}

/** Pure: resolve a comma-separated column spec (names or 1-based numbers) to indexes. */
export function resolveKeyColumns(header, spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;
  const out = [];
  raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      if (/^\d+$/.test(part)) {
        const index = Number(part) - 1;
        if (index >= 0 && index < header.length) out.push(index);
        return;
      }
      const index = indexOfHeader(header, part);
      if (index !== -1) out.push(index);
    });
  return out.length ? Array.from(new Set(out)) : null;
}

export const tool = {
  id: 'dedupe-rows',
  label: 'Dedupe rows',
  group: 'clean',
  order: 30,
  description:
    'Find repeated rows across the whole row or a chosen key. Remove them, or flag them and decide yourself.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'dedupe-rows',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        {
          name: 'keySpec',
          kind: 'text',
          label: 'Key columns (names or 1-based numbers; blank = the whole row)',
          placeholder: 'account_code, period'
        },
        {
          name: 'mode',
          kind: 'select',
          label: 'Action',
          value: 'remove',
          options: [
            { value: 'remove', label: 'Remove duplicates' },
            { value: 'flag', label: 'Flag duplicates, remove nothing' }
          ]
        },
        {
          name: 'keep',
          kind: 'select',
          label: 'When removing, keep',
          value: 'first',
          options: [
            { value: 'first', label: 'the first occurrence' },
            { value: 'last', label: 'the last occurrence' }
          ]
        },
        { name: 'ignoreCase', kind: 'checkbox', label: 'Ignore case', value: true },
        { name: 'ignoreWhitespace', kind: 'checkbox', label: 'Ignore whitespace differences', value: true },
        {
          name: 'loose',
          kind: 'checkbox',
          label: 'Loose match (also ignore punctuation) — use with care',
          value: false
        }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (grid.length < 2) return { summary: 'Paste a CSV with a header row and at least one data row.' };
        const keyColumns = resolveKeyColumns(grid[0], values.keySpec);
        const result = dedupeGrid(grid, { ...values, keyColumns });

        const extras = [];
        if (result.removed.length) {
          extras.push({
            label: 'Download removed rows',
            name: 'removed_duplicates',
            rows: [['original_row', 'duplicate_of_row', ...grid[0]], ...result.removed.map((entry) => [String(entry.index), String(entry.firstSeen), ...entry.row])]
          });
        }

        return {
          rows: result.rows,
          name: values.mode === 'flag' ? 'duplicates_flagged' : 'deduped',
          summary: [
            `${grid.length - 1} rows in`,
            `${result.rows.length - 1} rows out`,
            `${result.duplicateGroups} duplicated key(s)`,
            keyColumns ? `key: ${keyColumns.map((c) => grid[0][c]).join(' + ')}` : 'key: whole row'
          ],
          changes: result.changes,
          warnings: values.loose ? ['Loose match ignores punctuation, so "Note 12" and "Note-12" collapse. Check the removed-rows list.'] : [],
          extras
        };
      }
    });
  }
};
