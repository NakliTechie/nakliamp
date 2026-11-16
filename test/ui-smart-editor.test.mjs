// Smart playlist editor: rule rows to rule JSON and back (Y3).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_SPECS, opsFor, blankRow, normaliseRow, rowToClause, clauseToRow, formToRule, ruleToForm, ruleForCommand,
  dateInputToMs, msToDateInput, suggestionsFor, problemRow, SmartFormError, MAX_LIMIT,
} from '../app/ui/smart-editor.mjs';
import { SMART_FIELDS, validateSmart, evaluateSmart } from '../app/library/smart.mjs';
import { COMMANDS } from '../app/commands/commands.mjs';

test('the editor offers every smart field, and each operator it offers validates', () => {
  assert.deepEqual(Object.keys(FIELD_SPECS).sort(), [...SMART_FIELDS].sort());
  for (const field of SMART_FIELDS) {
    for (const op of opsFor(field)) {
      const row = { ...blankRow(field), op };
      if (FIELD_SPECS[field].kind === 'date' && !op.includes('last-days')) { row.a = '2024-01-01'; row.b = '2024-12-31'; }
      else if (['number', 'minutes'].includes(FIELD_SPECS[field].kind)) { row.a = '1'; row.b = '9'; }
      else if (FIELD_SPECS[field].kind === 'rating') { row.a = '2'; row.b = '4'; }
      else if (FIELD_SPECS[field].kind === 'text') row.a = 'x';
      const clause = rowToClause(row);
      assert.doesNotThrow(() => validateSmart({ name: 'n', match: 'all', rules: [clause] }), `${field} ${op}`);
    }
  }
});

test('text, number, rating and favourite rows become clauses', () => {
  assert.deepEqual(rowToClause({ field: 'genre', op: 'contains', a: 'jazz' }), { field: 'genre', op: 'contains', value: 'jazz' });
  assert.deepEqual(rowToClause({ field: 'year', op: 'between', a: '1960', b: '1969' }), { field: 'year', op: 'between', value: [1960, 1969] });
  assert.deepEqual(rowToClause({ field: 'rating', op: 'gt', a: '3' }), { field: 'rating', op: 'gt', value: 3 });
  assert.deepEqual(rowToClause({ field: 'favourite', op: 'is', a: 'true' }), { field: 'favourite', op: 'is', value: true });
  assert.deepEqual(rowToClause({ field: 'favourite', op: 'is', a: 'false' }), { field: 'favourite', op: 'is', value: false });
});

test('duration is typed in minutes and stored in seconds', () => {
  assert.deepEqual(rowToClause({ field: 'durationS', op: 'gt', a: '7.5' }), { field: 'durationS', op: 'gt', value: 450 });
  assert.deepEqual(clauseToRow({ field: 'durationS', op: 'lt', value: 90 }), { field: 'durationS', op: 'lt', a: '1.5', b: '' });
});

test('dates: day counts stay numbers, calendar dates become local midnight', () => {
  assert.deepEqual(rowToClause({ field: 'lastPlayedAt', op: 'not-in-last-days', a: '90' }), { field: 'lastPlayedAt', op: 'not-in-last-days', value: 90 });
  const clause = rowToClause({ field: 'addedAt', op: 'between', a: '2024-03-01', b: '2024-03-31' });
  assert.deepEqual(clause.value, [new Date(2024, 2, 1).getTime(), new Date(2024, 2, 31).getTime()]);
  assert.deepEqual(clauseToRow(clause), { field: 'addedAt', op: 'between', a: '2024-03-01', b: '2024-03-31' });
  assert.equal(dateInputToMs('2024-02-30'), null);
  assert.equal(dateInputToMs('soon'), null);
  assert.equal(msToDateInput(new Date(2023, 11, 5).getTime()), '2023-12-05');
});

test('bad values name the rule they are in', () => {
  assert.throws(() => rowToClause({ field: 'year', op: 'gt', a: '' }, 2), error => error instanceof SmartFormError && error.row === 2 && /Rule 3/.test(error.message));
  assert.throws(() => rowToClause({ field: 'addedAt', op: 'gt', a: 'not a date' }), /needs a date/);
  assert.throws(() => rowToClause({ field: 'lastPlayedAt', op: 'in-last-days', a: '-3' }), /negative/);
  assert.throws(() => rowToClause({ field: 'genre', op: 'gt', a: 'x' }), /does not apply/);
  assert.equal(problemRow({ where: 'rules[4]' }), 4);
  assert.equal(problemRow(new SmartFormError('x', 1)), 1);
  assert.equal(problemRow(new Error('x')), -1);
});

test('changing a row\'s field keeps its values only when the kind is the same', () => {
  assert.deepEqual(normaliseRow({ field: 'album', op: 'is', a: 'Blue', b: '', previousField: 'genre' }), { field: 'album', op: 'is', a: 'Blue', b: '' });
  assert.deepEqual(normaliseRow({ field: 'year', op: 'contains', a: 'Blue', b: '', previousField: 'genre' }), blankRow('year'));
  assert.equal(normaliseRow({ field: 'favourite', op: 'is', a: 'x', b: '', previousField: 'genre' }).a, 'true');
});

test('the whole form round-trips through a rule, and the rule fits the smart.create schema', () => {
  const form = {
    name: '  Unplayed jazz ', match: 'any', limit: '50', sortKey: 'addedAt', sortDirection: 'desc',
    rows: [{ field: 'genre', op: 'is', a: 'Jazz', b: '' }, { field: 'playCount', op: 'is', a: '0', b: '' }],
  };
  const rule = formToRule(form);
  assert.deepEqual(rule, {
    version: 1, name: 'Unplayed jazz', match: 'any', limit: 50, sort: { key: 'addedAt', direction: 'desc' },
    rules: [{ field: 'genre', op: 'is', value: 'Jazz' }, { field: 'playCount', op: 'is', value: 0 }],
  });
  const back = ruleToForm(rule);
  assert.deepEqual(back, { ...form, name: 'Unplayed jazz' });
  const input = ruleForCommand(rule);
  assert.equal('version' in input, false);
  const schema = COMMANDS.find(command => command.name === 'smart.create').input.properties.rule;
  for (const key of Object.keys(input)) assert.ok(key in schema.properties, `smart.create accepts ${key}`);
});

test('the form refuses a missing name and an out-of-range limit', () => {
  const base = { name: 'x', match: 'all', rows: [], limit: '', sortKey: '' };
  assert.throws(() => formToRule({ ...base, name: ' ' }), /name/);
  assert.throws(() => formToRule({ ...base, limit: '0' }), /limit/);
  assert.throws(() => formToRule({ ...base, limit: String(MAX_LIMIT + 1) }), /limit/);
  assert.throws(() => formToRule({ ...base, limit: '2.5' }), /limit/);
  assert.equal(formToRule(base).limit, undefined);
});

test('a new form has one starter rule and the preview counts through evaluateSmart', () => {
  const fresh = ruleToForm(null);
  assert.equal(fresh.rows.length, 1);
  const tracks = [{ id: 'a', genre: 'Jazz' }, { id: 'b', genre: 'Rock' }, { id: 'c', genre: 'jazz fusion' }];
  const rule = formToRule({ ...fresh, name: 'J', rows: [{ field: 'genre', op: 'contains', a: 'jazz', b: '' }] });
  assert.deepEqual(evaluateSmart(rule, tracks).map(track => track.id), ['a', 'c']);
});

test('suggestions list distinct values, most common first, for text fields only', () => {
  const tracks = [{ genre: 'Rock' }, { genre: 'Jazz' }, { genre: 'Rock' }, { genre: '' }, {}];
  assert.deepEqual(suggestionsFor(tracks, 'genre'), ['Rock', 'Jazz']);
  assert.deepEqual(suggestionsFor(tracks, 'year'), []);
});
