/**
 * Schema check — group `verify`, order 20.
 *
 * v1's `validateSchema` checked that the required column NAMES were present and
 * then reported `rows.length - 1` as "data rows checked" without looking at a
 * single one of them. That is worse than no check: it prints a pass.
 *
 * This version validates every cell of every row against a declared rule and
 * returns a row-and-column-addressed issue list you can export.
 *
 * Rule syntax, one column per line:
 *
 *   account_code: text, required, unique
 *   amount:       number, required, min=0
 *   period:       date
 *   segment:      enum=upstream|downstream|corporate
 *   note_ref:     text, pattern=^\d{1,2}$
 *   units:        text
 *
 * Anything after the colon is a comma-separated list of: a type
 * (text|number|integer|date|boolean|any), the flags `required` and `unique`,
 * and the settings min=, max=, pattern=, enum=, maxlen=.
 */
import { buildTool, requireNumbers, parseCsvText, rectangularise, indexOfHeader } from './_shared.js';

export const TYPES = ['any', 'text', 'number', 'integer', 'date', 'boolean'];

/** Pure: parse the rule text into rules. Unparseable lines come back as warnings. */
/**
 * Split a rule's options on commas, but NOT on commas that belong to a regex.
 * `note_ref: text, pattern=^\d{1,2}$` has two options, not three — the comma in
 * the `{1,2}` quantifier is part of the pattern. Splitting naively truncated it
 * to `^\d{1`, which then rejected every value it was meant to accept.
 */
export function splitOptions(text) {
  const parts = [];
  let buf = '';
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let escaped = false;

  for (const ch of String(text || '')) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (!bracket && ch === '{') brace += 1;
    else if (!bracket && ch === '}') brace = Math.max(0, brace - 1);
    else if (!bracket && ch === '(') paren += 1;
    else if (!bracket && ch === ')') paren = Math.max(0, paren - 1);

    if (ch === ',' && !brace && !bracket && !paren) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.filter((p) => p.trim());
}

export function parseSpec(text) {
  const rules = [];
  const warnings = [];
  String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => {
      const colon = line.indexOf(':');
      if (colon === -1) {
        warnings.push(`Ignored "${line}" — a rule looks like  column: type, required`);
        return;
      }
      const column = line.slice(0, colon).trim();
      const rule = { column, type: 'any', required: false, unique: false };
      splitOptions(line.slice(colon + 1))
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => {
          const eq = part.indexOf('=');
          if (eq === -1) {
            const word = part.toLowerCase();
            if (TYPES.includes(word)) rule.type = word;
            else if (word === 'required') rule.required = true;
            else if (word === 'unique') rule.unique = true;
            else if (word === 'optional') rule.required = false;
            else warnings.push(`Ignored "${part}" in the rule for ${column}.`);
            return;
          }
          const key = part.slice(0, eq).trim().toLowerCase();
          const value = part.slice(eq + 1).trim();
          if (key === 'min') rule.min = Number(value);
          else if (key === 'max') rule.max = Number(value);
          else if (key === 'maxlen') rule.maxlen = Number(value);
          else if (key === 'pattern') rule.pattern = value;
          else if (key === 'enum') rule.enum = value.split('|').map((v) => v.trim());
          else warnings.push(`Ignored "${part}" in the rule for ${column}.`);
        });
      rules.push(rule);
    });
  return { rules, warnings };
}

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,
  /^\d{1,2}-\d{1,2}-\d{4}$/,
  /^\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{4}$/,
  /^[A-Za-z]{3,9} \d{1,2}, \d{4}$/
];

/** Pure: does this look like a date we can trust? */
export function looksLikeDate(value) {
  const text = String(value || '').trim();
  if (!DATE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  const parsed = Date.parse(text.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, '$3-$2-$1'));
  return !Number.isNaN(parsed);
}

/**
 * Pure. `deps.parseNumber` is injected so this is testable under Node without
 * the browser number engine.
 *
 * @returns { issues, stats, missingColumns, extraColumns, badRows:Set<number> }
 */
export function validateRows(grid, rules, deps) {
  const parseNumber = (deps && deps.parseNumber) || (() => ({ value: null }));
  const source = rectangularise(grid);
  if (source.length < 1) throw new Error('No CSV rows found.');

  const header = source[0];
  const body = source.slice(1);
  const issues = [];
  const badRows = new Set();
  const missingColumns = [];
  const seenValues = new Map(); // column -> Map(value -> first row)

  const bound = rules.map((rule) => {
    const index = indexOfHeader(header, rule.column);
    if (index === -1) missingColumns.push(rule.column);
    return { rule, index };
  });

  const declared = new Set(
    bound.filter((b) => b.index !== -1).map((b) => b.index)
  );
  const extraColumns = header.filter((_, index) => !declared.has(index));

  const add = (row, column, message, value) => {
    issues.push({ row, column, message, value: value === undefined ? '' : String(value) });
    badRows.add(row);
  };

  bound.forEach(({ rule, index }) => {
    if (index === -1) return;
    if (rule.unique) seenValues.set(index, new Map());
    let regex = null;
    if (rule.pattern) {
      try {
        regex = new RegExp(rule.pattern);
      } catch {
        issues.push({ row: 0, column: rule.column, message: `pattern "${rule.pattern}" is not a valid regular expression`, value: '' });
      }
    }

    body.forEach((row, bodyIndex) => {
      const rowNumber = bodyIndex + 2; // 1-based, header is row 1
      const raw = row[index] === undefined || row[index] === null ? '' : String(row[index]);
      const value = raw.trim();

      if (!value) {
        if (rule.required) add(rowNumber, rule.column, 'required value is empty');
        return;
      }

      if (rule.type === 'number' || rule.type === 'integer') {
        const parsed = parseNumber(raw);
        if (parsed.value === null) {
          add(rowNumber, rule.column, `expected a ${rule.type}, got text`, raw);
          return;
        }
        if (rule.type === 'integer' && !Number.isInteger(parsed.value)) {
          add(rowNumber, rule.column, 'expected a whole number', raw);
        }
        if (rule.min !== undefined && parsed.value < rule.min) {
          add(rowNumber, rule.column, `below min=${rule.min}`, raw);
        }
        if (rule.max !== undefined && parsed.value > rule.max) {
          add(rowNumber, rule.column, `above max=${rule.max}`, raw);
        }
      } else if (rule.type === 'date') {
        if (!looksLikeDate(value)) add(rowNumber, rule.column, 'not a recognisable date', raw);
      } else if (rule.type === 'boolean') {
        if (!/^(true|false|yes|no|y|n|0|1)$/i.test(value)) {
          add(rowNumber, rule.column, 'not a boolean', raw);
        }
      }

      if (rule.enum && !rule.enum.some((option) => option.toLowerCase() === value.toLowerCase())) {
        add(rowNumber, rule.column, `not one of: ${rule.enum.join(', ')}`, raw);
      }
      if (regex && !regex.test(value)) {
        add(rowNumber, rule.column, `does not match ${rule.pattern}`, raw);
      }
      if (rule.maxlen !== undefined && value.length > rule.maxlen) {
        add(rowNumber, rule.column, `longer than maxlen=${rule.maxlen} (${value.length} chars)`, raw);
      }
      if (rule.unique) {
        const bucket = seenValues.get(index);
        const key = value.toLowerCase();
        if (bucket.has(key)) add(rowNumber, rule.column, `duplicate value, first seen at row ${bucket.get(key)}`, raw);
        else bucket.set(key, rowNumber);
      }
    });
  });

  issues.sort((a, b) => a.row - b.row || String(a.column).localeCompare(String(b.column)));

  return {
    issues,
    badRows,
    missingColumns,
    extraColumns,
    stats: {
      rowsChecked: body.length,
      rulesApplied: bound.filter((b) => b.index !== -1).length,
      rowsWithIssues: badRows.size,
      issueCount: issues.length
    }
  };
}

export const tool = {
  id: 'schema-check',
  label: 'Schema check',
  group: 'verify',
  order: 20,
  description:
    'Declare the columns and types you expect, then check every row against them. Reports the exact row and column of each failure.',

  mount(container, ctx) {
    buildTool(container, ctx, {
      id: 'schema-check',
      description: tool.description,
      inputs: [
        { name: 'source', kind: 'csv', label: 'CSV (header row first)' },
        {
          name: 'spec',
          kind: 'textarea',
          rows: 8,
          label: 'Expected schema — one column per line',
          placeholder:
            'account_code: text, required, unique\namount: number, required, min=0\nperiod: date\nsegment: enum=upstream|downstream|corporate'
        },
        {
          name: 'strict',
          kind: 'checkbox',
          label: 'Flag columns present in the CSV but absent from the schema',
          value: false
        }
      ],

      async run(values) {
        const grid = parseCsvText(values.source);
        if (grid.length < 1) return { summary: 'Paste a CSV to validate.' };
        const spec = parseSpec(values.spec);
        if (!spec.rules.length) {
          return {
            summary: `Declare a schema. Headers found: ${grid[0].join(', ')}`,
            warnings: spec.warnings
          };
        }

        const parseNumber = await requireNumbers();
        const result = validateRows(grid, spec.rules, { parseNumber });

        const rows = [
          ['row', 'column', 'value', 'problem'],
          ...result.issues.map((issue) => [String(issue.row), issue.column, issue.value, issue.message])
        ];
        if (result.issues.length === 0) rows.push(['', '', '', 'no issues found']);

        const warnings = [...spec.warnings];
        if (result.missingColumns.length) {
          warnings.push(`Columns declared in the schema but missing from the CSV: ${result.missingColumns.join(', ')}`);
        }
        if (values.strict && result.extraColumns.length) {
          warnings.push(`Columns in the CSV with no rule: ${result.extraColumns.join(', ')}`);
        }
        if (result.stats.issueCount) {
          warnings.push(
            `${result.stats.issueCount} issue(s) across ${result.stats.rowsWithIssues} of ${result.stats.rowsChecked} row(s).`
          );
        }

        const annotated = rectangularise(grid).map((row, index) => {
          if (index === 0) return [...row, 'schema_issues'];
          const forRow = result.issues.filter((issue) => issue.row === index + 1);
          return [...row, forRow.map((issue) => `${issue.column}: ${issue.message}`).join('; ')];
        });
        const cleanOnly = [rectangularise(grid)[0], ...rectangularise(grid).slice(1).filter((_, i) => !result.badRows.has(i + 2))];

        return {
          rows,
          name: 'schema_issues',
          summary: [
            `${result.stats.rowsChecked} row(s) checked`,
            `${result.stats.rulesApplied} rule(s) applied`,
            result.stats.issueCount ? `${result.stats.issueCount} issue(s)` : 'no issues'
          ],
          changes: ['Nothing was changed — this tool only reports.'],
          warnings,
          extras: [
            { label: 'Download CSV annotated with issues', name: 'annotated', rows: annotated },
            {
              label: `Download passing rows only (${cleanOnly.length - 1})`,
              name: 'passing_rows',
              rows: cleanOnly
            }
          ]
        };
      }
    });
  }
};
