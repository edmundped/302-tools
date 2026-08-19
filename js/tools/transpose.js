/**
 * Transpose — group `clean`, order 40.
 *
 * Financial statements arrive with periods across the top and line items down
 * the side; almost every analysis wants the opposite. Transpose is the cheapest
 * fix and v1 did not have it at all.
 */
import { buildTool, parseCsvText, rectangularise, uniqueHeaders } from './_shared.js';

/** Pure: straight matrix transpose. Rectangularises first, so the result is rectangular too. */
export function transposeGrid(grid) {
  const source = rectangularise(grid);
  if (!source.length) return [];
  const width = source[0].length;
  const out = [];
  for (let c = 0; c < width; c += 1) {
    out.push(source.map((row) => row[c]));
  }
  return out;
}

/**
 * Pure: transpose treating row 0 as a header row.
 * The old header becomes the new first column; the old first column becomes the
 * new header row. `cornerLabel` names the new top-left cell.
 */
export function transposeWithHeader(grid, cornerLabel) {
  const flipped = transposeGrid(grid);
  if (!flipped.length) return [];
  const header = flipped[0].slice();
  header[0] = cornerLabel || header[0] || 'field';
  const out = [uniqueHeaders(header), ...flipped.slice(1)];
  return rectangularise(out);
}

export const tool = {
  id: 'transpose',
  label: 'Transpose',
  group: 'clean',
  order: 40,
  description: 'Flip rows and columns. Optionally promote the original first column to the new header row.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'transpose',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV' },
        {
          name: 'mode',
          kind: 'select',
          label: 'Mode',
          value: 'header',
          options: [
            { value: 'header', label: 'Header-aware (first column becomes the new header)' },
            { value: 'raw', label: 'Raw matrix transpose (no header handling)' }
          ]
        },
        {
          name: 'cornerLabel',
          kind: 'text',
          label: 'Header-aware: name for the new first column',
          placeholder: 'field',
          value: 'field'
        }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (!grid.length) return { summary: 'Paste a CSV to transpose.' };
        const before = { rows: grid.length, cols: rectangularise(grid)[0].length };
        const rows =
          values.mode === 'raw' ? transposeGrid(grid) : transposeWithHeader(grid, values.cornerLabel);
        const after = { rows: rows.length, cols: rows.length ? rows[0].length : 0 };

        const warnings = [];
        if (before.cols > 200) {
          warnings.push(`The result has ${before.cols} rows because the input had ${before.cols} columns. Check this is what you meant.`);
        }
        const dupes = new Set();
        if (values.mode === 'header' && rows.length) {
          const counts = new Map();
          grid.slice(1).forEach((row) => {
            const label = String(row[0] || '').trim().toLowerCase();
            counts.set(label, (counts.get(label) || 0) + 1);
          });
          counts.forEach((count, label) => {
            if (count > 1 && label) dupes.add(label);
          });
          if (dupes.size) {
            warnings.push(
              `Repeated labels in the first column became repeated headers and were suffixed to keep them distinct: ${Array.from(dupes).slice(0, 6).join(', ')}`
            );
          }
        }

        return {
          rows,
          name: 'transposed',
          summary: [`${before.rows}x${before.cols} -> ${after.rows}x${after.cols}`],
          changes: [
            `transposed ${before.rows} rows x ${before.cols} columns into ${after.rows} rows x ${after.cols} columns`,
            values.mode === 'header'
              ? 'the original header row is now the first column'
              : 'raw transpose: no header was promoted'
          ],
          warnings
        };
      }
    });
  }
};
