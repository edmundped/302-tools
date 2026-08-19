/**
 * Header mapper — group `annotate`, order 20.
 *
 * v1 lowercased the incoming header, looked it up in a map, and returned the
 * original if it missed — silently. You could not tell a mapped column from an
 * unmapped one, which is the only thing you actually want to know.
 *
 * This version reports every header as mapped / unmapped / unused-rule, can
 * suggest a mapping against a canonical column list, and can reorder and pad
 * the table to the canonical schema so downstream files all have the same shape.
 */
import { buildTool, parseCsvText, rectangularise, normaliseKey, uniqueHeaders } from './_shared.js';

/** Pure: parse `messy = canonical` lines into a lookup keyed by normalised header. */
export function parseMap(text) {
  const map = new Map();
  const warnings = [];
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => {
      const eq = line.indexOf('=');
      if (eq === -1) {
        warnings.push(`Ignored "${line}" — a mapping line looks like  messy header = canonical_name`);
        return;
      }
      const messy = line.slice(0, eq).trim();
      const canonical = line.slice(eq + 1).trim();
      if (!messy || !canonical) {
        warnings.push(`Ignored "${line}" — both sides are required.`);
        return;
      }
      map.set(normaliseKey(messy), { canonical, messy });
    });
  return { map, warnings };
}

function tokens(value) {
  return new Set(normaliseKey(value).split(' ').filter(Boolean));
}

/** Pure: 0..1 similarity used only to propose a mapping, never to apply one. */
export function similarity(a, b) {
  const ka = normaliseKey(a);
  const kb = normaliseKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  let shared = 0;
  ta.forEach((token) => {
    if (tb.has(token)) shared += 1;
  });
  const jaccard = shared / (ta.size + tb.size - shared || 1);
  const contains = ka.includes(kb) || kb.includes(ka) ? 0.5 : 0;
  return Math.min(1, jaccard + contains);
}

/** Pure: propose `messy = canonical` lines for headers not already mapped. */
export function suggestMapping(headers, canonicalList, threshold) {
  const min = threshold === undefined ? 0.45 : threshold;
  return headers
    .map((header) => {
      let best = null;
      canonicalList.forEach((canonical) => {
        const score = similarity(header, canonical);
        if (!best || score > best.score) best = { canonical, score };
      });
      return best && best.score >= min ? { header, canonical: best.canonical, score: best.score } : null;
    })
    .filter(Boolean);
}

/**
 * Pure.
 * @param options { canonicalOrder:string[]|null, dropUnmapped:boolean }
 * @returns { rows, mapped, unmapped, unusedRules, addedCols:Set<number>, changes }
 */
export function applyMap(grid, map, options) {
  const opts = { canonicalOrder: null, dropUnmapped: false, ...(options || {}) };
  const source = rectangularise(grid);
  if (!source.length) return { rows: [], mapped: [], unmapped: [], unusedRules: [], addedCols: new Set(), changes: [] };

  const header = source[0];
  const used = new Set();
  const mapped = [];
  const unmapped = [];

  const renamed = header.map((label) => {
    const hit = map.get(normaliseKey(label));
    if (hit) {
      used.add(normaliseKey(label));
      mapped.push({ from: String(label), to: hit.canonical });
      return hit.canonical;
    }
    unmapped.push(String(label));
    return String(label);
  });

  const unusedRules = [];
  map.forEach((entry, key) => {
    if (!used.has(key)) unusedRules.push(entry.messy);
  });

  const changes = mapped.map((m) => `"${m.from}" -> "${m.to}"`);
  const addedCols = new Set();
  let rows;

  if (opts.canonicalOrder && opts.canonicalOrder.length) {
    const position = new Map();
    renamed.forEach((label, index) => {
      const key = normaliseKey(label);
      if (!position.has(key)) position.set(key, index);
    });
    const order = opts.canonicalOrder.slice();
    if (!opts.dropUnmapped) {
      renamed.forEach((label) => {
        if (!order.some((canonical) => normaliseKey(canonical) === normaliseKey(label))) order.push(label);
      });
    }
    rows = [
      uniqueHeaders(order),
      ...source.slice(1).map((row) =>
        order.map((label) => {
          const index = position.get(normaliseKey(label));
          return index === undefined ? '' : row[index] === undefined ? '' : row[index];
        })
      )
    ];
    order.forEach((label, index) => {
      if (!position.has(normaliseKey(label))) {
        addedCols.add(index);
        changes.push(`added empty column "${label}" required by the canonical schema`);
      }
    });
    const droppedNames = renamed.filter(
      (label) => !order.some((canonical) => normaliseKey(canonical) === normaliseKey(label))
    );
    droppedNames.forEach((label) => changes.push(`dropped column "${label}" (not in the canonical schema)`));
  } else if (opts.dropUnmapped) {
    const keep = renamed.map((_, index) => index).filter((index) => !unmapped.includes(String(header[index])));
    rows = [keep.map((i) => renamed[i]), ...source.slice(1).map((row) => keep.map((i) => row[i]))];
    unmapped.forEach((label) => changes.push(`dropped unmapped column "${label}"`));
  } else {
    rows = [uniqueHeaders(renamed), ...source.slice(1)];
  }

  return { rows: rectangularise(rows), mapped, unmapped, unusedRules, addedCols, changes };
}

export const tool = {
  id: 'header-map',
  label: 'Header mapper',
  group: 'annotate',
  order: 20,
  description:
    'Rename messy headers onto a canonical schema, reorder to that schema, and see exactly which headers were mapped, missed, or invented.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'header-map',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        {
          name: 'mapText',
          kind: 'textarea',
          rows: 6,
          label: 'Mapping — one per line, messy = canonical',
          placeholder: 'Acct. Code = account_code\nAmount (GH¢000) = amount\n2011 = fy2011'
        },
        {
          name: 'canonicalText',
          kind: 'textarea',
          rows: 3,
          label: 'Canonical column order (optional, comma or newline separated)',
          placeholder: 'account_code, description, amount, period'
        },
        {
          name: 'suggest',
          kind: 'checkbox',
          label: 'Suggest a mapping for unmapped headers against the canonical list',
          value: true
        },
        { name: 'dropUnmapped', kind: 'checkbox', label: 'Drop columns that are not in the schema', value: false }
      ],

      run(values) {
        const grid = parseCsvText(values.source);
        if (grid.length < 1) return { summary: 'Paste a CSV to map.' };

        const parsed = parseMap(values.mapText);
        const canonicalOrder = String(values.canonicalText || '')
          .split(/[,\n]/)
          .map((part) => part.trim())
          .filter(Boolean);

        const result = applyMap(grid, parsed.map, {
          canonicalOrder: canonicalOrder.length ? canonicalOrder : null,
          dropUnmapped: values.dropUnmapped
        });

        const warnings = [...parsed.warnings];
        if (result.unmapped.length) {
          warnings.push(`Left unmapped: ${result.unmapped.join(', ')}`);
        }
        if (result.unusedRules.length) {
          warnings.push(`Mapping rules that matched nothing: ${result.unusedRules.join(', ')}`);
        }

        const extras = [
          {
            label: 'Download mapping report',
            name: 'header_mapping',
            rows: [
              ['original_header', 'canonical_header', 'status'],
              ...result.mapped.map((m) => [m.from, m.to, 'mapped']),
              ...result.unmapped.map((label) => [label, '', 'unmapped']),
              ...result.unusedRules.map((label) => ['', label, 'rule matched nothing'])
            ]
          }
        ];

        if (values.suggest && canonicalOrder.length && result.unmapped.length) {
          const suggestions = suggestMapping(result.unmapped, canonicalOrder);
          if (suggestions.length) {
            warnings.push(
              `Suggested rules — paste into the mapping box if they look right:\n${suggestions
                .map((s) => `${s.header} = ${s.canonical}   # confidence ${(s.score * 100).toFixed(0)}%`)
                .join('\n')}`
            );
            extras.push({
              label: 'Copy suggested rules',
              name: 'suggested_mapping',
              text: suggestions.map((s) => `${s.header} = ${s.canonical}`).join('\n'),
              mime: 'text/plain;charset=utf-8'
            });
          }
        }

        return {
          rows: result.rows,
          addedCols: result.addedCols,
          name: 'headers_mapped',
          summary: [
            `${result.mapped.length} mapped`,
            `${result.unmapped.length} unmapped`,
            canonicalOrder.length ? `reordered to ${canonicalOrder.length} canonical column(s)` : 'original order kept'
          ],
          changes: result.changes,
          warnings,
          extras
        };
      }
    });
  }
};
