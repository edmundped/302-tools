/**
 * Number cleaner — group `clean`, order 10.
 *
 * Delegates every parse to core/numbers.js. There is no parser in this file;
 * a second number parser in this codebase is a defect.
 *
 * This tool also absorbs v1's separate "unit normaliser": scaling a parsed
 * value by 1000 / 0.001 / 1e6 / 1e-6 is one extra step on the same parse, and
 * two numeric tools sitting next to each other made analysts guess which one to
 * reach for. Scale is now an option here.
 */
import { buildTool, requireNumbers, parseCsvText, rectangularise, indexOfHeader } from './_shared.js';

export const SCALES = [
  { value: '1', label: 'No scaling' },
  { value: '1000', label: 'Thousands -> units (x1,000)' },
  { value: '0.001', label: 'Units -> thousands (/1,000)' },
  { value: '1000000', label: 'Millions -> units (x1,000,000)' },
  { value: '0.000001', label: 'Units -> millions (/1,000,000)' }
];

/** Pure: apply the scale and rounding to a parsed value. Returns a string. */
export function applyScale(value, factor, decimals) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const scaled = value * factor;
  if (decimals === '' || decimals === null || decimals === undefined) {
    // Avoid float dust such as 1.2340000000000002 without forcing a decimal count.
    return String(Number(scaled.toPrecision(15)));
  }
  return scaled.toFixed(Number(decimals));
}

/** Pure: which columns did the user ask for? Accepts names or 1-based indexes. */
export function resolveColumns(header, spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null; // null === "decide per cell"
  const wanted = [];
  raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      // Name first: financial headers ARE years ("2011"), so a digits-only
      // spec must be matched against the header before it is read as an index.
      const named = indexOfHeader(header, part);
      if (named !== -1) {
        wanted.push(named);
        return;
      }
      if (/^\d+$/.test(part)) {
        const index = Number(part) - 1;
        if (index >= 0 && index < header.length) wanted.push(index);
        return;
      }
      const index = indexOfHeader(header, part);
      if (index !== -1) wanted.push(index);
    });
  return Array.from(new Set(wanted));
}

function describe(parsed) {
  const notes = [];
  if (parsed.hadParens) notes.push('parentheses negative');
  if (parsed.isPercent) notes.push('percent -> fraction');
  if (parsed.isNegative && !parsed.hadParens) notes.push('negative');
  if (Array.isArray(parsed.warnings)) notes.push(...parsed.warnings);
  else if (parsed.warning) notes.push(parsed.warning);
  if (parsed.value === null && String(parsed.raw || '').trim()) notes.push('not numeric — left as text');
  return notes.join('; ');
}

export const tool = {
  id: 'number-clean',
  label: 'Number cleaner',
  group: 'clean',
  order: 10,
  description:
    'Parse messy financial figures — (1,234), 1234-, GH¢ 1 234,56, 12.3%, 1,234² — into clean numbers. A dash stays empty, never zero.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'number-clean',
      description: tool.description,
      inputs: [
        {
          name: 'source',
          kind: 'csv',
          label: 'Values (one per line) or a CSV with a header row',
          placeholder: '(1,234)\nGH¢ 12,442,697\n12.3%\n–\n1,234²'
        },
        {
          name: 'mode',
          kind: 'select',
          label: 'Input is',
          value: 'lines',
          options: [
            { value: 'lines', label: 'One value per line' },
            { value: 'csv', label: 'A CSV table' }
          ]
        },
        {
          name: 'columns',
          kind: 'text',
          label: 'CSV mode: columns to clean (names or 1-based numbers, blank = every numeric-looking cell)',
          placeholder: '2011, 2010'
        },
        { name: 'scale', kind: 'select', label: 'Scale', value: '1', options: SCALES },
        {
          name: 'decimals',
          kind: 'number',
          label: 'Decimal places (blank = keep as parsed)',
          min: 0,
          max: 8,
          placeholder: ''
        }
      ],

      async run(values) {
        const parseNumber = await requireNumbers();
        const factor = Number(values.scale) || 1;
        const decimals = values.decimals;

        if (values.mode === 'lines') {
          const lines = String(values.source || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length);
          if (!lines.length) return { summary: 'Paste some values to clean.' };

          const rows = [['raw', 'clean', 'value', 'notes']];
          const changes = [];
          let numeric = 0;
          let blanked = 0;

          lines.forEach((line) => {
            const parsed = parseNumber(line);
            const clean = parsed.value === null ? '' : applyScale(parsed.value, factor, decimals);
            if (parsed.value !== null) numeric += 1;
            if (parsed.value === null && line) blanked += 1;
            rows.push([line, parsed.value === null ? parsed.clean || '' : clean, String(parsed.value === null ? '' : parsed.value), describe(parsed)]);
            if (line !== clean) changes.push(`"${line}" -> ${clean === '' ? '(empty)' : clean}`);
          });

          return {
            rows,
            name: 'cleaned_numbers',
            summary: [`${lines.length} value(s)`, `${numeric} numeric`, `${blanked} not numeric`],
            changes,
            warnings: blanked
              ? [`${blanked} value(s) did not parse as numbers. Their original text is kept in the "raw" column.`]
              : []
          };
        }

        const grid = parseCsvText(values.source);
        if (grid.length < 2) return { summary: 'Paste a CSV with a header row and at least one data row.' };

        const header = grid[0];
        const wanted = resolveColumns(header, values.columns);
        const out = rectangularise(grid).map((row) => row.slice());
        const changed = new Set();
        const changes = [];
        const noteRows = [['row', 'column', 'raw', 'clean', 'notes']];
        let touched = 0;

        for (let r = 1; r < out.length; r += 1) {
          for (let c = 0; c < out[r].length; c += 1) {
            if (wanted && !wanted.includes(c)) continue;
            const raw = out[r][c];
            if (!String(raw).trim()) continue;
            const parsed = parseNumber(raw);
            // With no explicit column list, leave anything non-numeric alone.
            if (!wanted && parsed.value === null) continue;
            const clean = parsed.value === null ? '' : applyScale(parsed.value, factor, decimals);
            if (clean === String(raw)) continue;
            out[r][c] = clean;
            changed.add(`${r},${c}`);
            touched += 1;
            const note = describe(parsed);
            changes.push(`row ${r} · ${header[c] || `col ${c + 1}`}: "${raw}" -> ${clean === '' ? '(empty)' : clean}${note ? ` (${note})` : ''}`);
            noteRows.push([String(r), header[c] || `col ${c + 1}`, String(raw), clean, note]);
          }
        }

        return {
          rows: out,
          changed,
          name: 'cleaned_table',
          summary: [
            `${out.length - 1} data rows`,
            `${touched} cell(s) rewritten`,
            wanted ? `${wanted.length} column(s) targeted` : 'auto-detected numeric cells'
          ],
          changes,
          extras: touched ? [{ label: 'Download change log', name: 'number_clean_changes', rows: noteRows }] : []
        };
      }
    });
  }
};
