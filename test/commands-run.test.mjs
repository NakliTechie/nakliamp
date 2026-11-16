// Command runner: validation, refusals, approval classes, host list. Run: node --test test/commands-run.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindCommands, validate, hostCommandList, CommandError } from '../app/commands/run.mjs';
import { COMMANDS, commandByName } from '../app/commands/commands.mjs';

test('validate covers type, required, enum, ranges, lengths, items and extra fields', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['n'],
    properties: {
      n: { type: 'integer', minimum: 0, maximum: 5 },
      s: { type: 'string', minLength: 1, maxLength: 3 },
      e: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 },
      anything: { description: 'no type' },
    },
  };
  assert.deepEqual(validate(schema, { n: 3, s: 'ab', e: 'a', list: [1.5], anything: [1] }), []);
  assert.deepEqual(validate(schema, {}), ['input.n is required']);
  assert.deepEqual(validate(schema, { n: 2.5 }), ['input.n must be an integer']);
  assert.deepEqual(validate(schema, { n: 6 }), ['input.n must be at most 5']);
  assert.deepEqual(validate(schema, { n: -1 }), ['input.n must be at least 0']);
  assert.deepEqual(validate(schema, { n: 1, s: '' }), ['input.s must have at least 1 characters']);
  assert.deepEqual(validate(schema, { n: 1, s: 'abcd' }), ['input.s must have at most 3 characters']);
  assert.deepEqual(validate(schema, { n: 1, e: 'c' }), ['input.e must be one of a, b']);
  assert.deepEqual(validate(schema, { n: 1, list: [] }), ['input.list must have at least 1 items']);
  assert.deepEqual(validate(schema, { n: 1, list: [1, 2, 3] }), ['input.list must have at most 2 items']);
  assert.deepEqual(validate(schema, { n: 1, list: ['x'] }), ['input.list[0] must be of type number']);
  assert.deepEqual(validate(schema, { n: 1, extra: 1 }), ['input.extra is not a known field']);
  assert.deepEqual(validate(schema, []), ['input must be of type object']);
  assert.deepEqual(validate({ type: 'number' }, NaN), ['input must be of type number']);
});

test('one-of-two inputs (seek, volume, visualiser) need exactly one field', () => {
  const seek = commandByName.get('player.seek').input;
  assert.deepEqual(validate(seek, { seconds: 12 }), []);
  assert.equal(validate(seek, {}).length, 1);
  assert.equal(validate(seek, { seconds: 1, percent: 5 }).length, 1);
});

test('run refuses unknown names and missing handlers with [not-found]', async () => {
  const run = bindCommands({});
  await assert.rejects(run('player.dance'), err => err instanceof CommandError && err.code === 'not-found' && err.message.startsWith('[not-found]'));
  await assert.rejects(run('player.play'), { code: 'not-found' });
});

test('run refuses bad input with [invalid-input] and never calls the handler', async () => {
  let called = 0;
  const run = bindCommands({ 'track.rate': () => { called++; } });
  await assert.rejects(run('track.rate', { rating: 7 }), err => err.code === 'invalid-input' && /at most 5/.test(err.message));
  await assert.rejects(run('track.rate', {}), { code: 'invalid-input' });
  await assert.rejects(run('track.rate', { rating: 3, path: '/etc' }), { code: 'invalid-input' });
  assert.equal(called, 0);
});

test('read and reversible commands run without asking and return the handler result', async () => {
  let asked = 0;
  const run = bindCommands({
    'player.status': () => ({ playing: false }),
    'queue.add': { run: (input, ctx) => ({ added: input.ids.length, from: ctx.from }) },
  }, { confirm: () => { asked++; return true; } });
  assert.deepEqual(await run('player.status'), { playing: false });
  assert.deepEqual(await run('player.status', undefined), { playing: false });
  assert.deepEqual(await run('queue.add', { ids: ['a', 'b'] }, { context: { from: 'ui' } }), { added: 2, from: 'ui' });
  assert.equal(asked, 0);
});

test('destructive commands show the diff, run on approval and refuse with [declined]', async () => {
  const requests = [];
  let deleted = 0;
  let answer = false;
  const handlers = {
    'playlist.delete': { diff: input => ({ removes: `${input.name}.m3u8` }), run: () => { deleted++; return { ok: true }; } },
  };
  const run = bindCommands(handlers, { confirm: async request => { requests.push(request); return answer; } });
  await assert.rejects(run('playlist.delete', { name: 'Road' }), err => err.code === 'declined');
  assert.equal(deleted, 0);
  assert.deepEqual(requests[0], { name: 'playlist.delete', label: 'Delete playlist', input: { name: 'Road' }, diff: { removes: 'Road.m3u8' } });
  answer = true;
  assert.deepEqual(await run('playlist.delete', { name: 'Road' }), { ok: true });
  assert.equal(deleted, 1);
});

test('without a confirm function destructive commands are declined; approved calls skip the prompt', async () => {
  let ran = 0;
  const run = bindCommands({ 'track.edit_tags': () => { ran++; return 'written'; } });
  await assert.rejects(run('track.edit_tags', { ids: ['a'], patch: { title: 'X' } }), { code: 'declined' });
  assert.equal(await run('track.edit_tags', { ids: ['a'], patch: { title: 'X' } }, { approved: true }), 'written');
  assert.equal(ran, 1);
  await assert.rejects(run('track.edit_tags', { ids: ['a'], patch: { title: 'X' } }, { approved: true }).then(() => run('track.edit_tags', { ids: ['a'], patch: { path: 'x' } }, { approved: true })), { code: 'invalid-input' });
});

test('hostCommandList gives NakliOS every command with rail scopes and approved handlers', async () => {
  let seen = null;
  const run = bindCommands({ 'track.edit_tags': (input, ctx) => { seen = ctx; return 'ok'; } });
  const list = hostCommandList(run);
  assert.equal(list.length, COMMANDS.length);
  for (const c of list) {
    assert.equal(typeof c.handler, 'function');
    assert.ok(['read', 'write', 'destructive'].includes(c.scope), c.name);
  }
  const edit = list.find(c => c.name === 'track.edit_tags');
  assert.equal(edit.scope, 'destructive');
  assert.equal(await edit.handler({ ids: ['a'], patch: { year: 1999 } }), 'ok');
  assert.deepEqual(seen, { from: 'host' });
  assert.equal(list.find(c => c.name === 'queue.add').scope, 'write');
});
