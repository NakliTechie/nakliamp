import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandByName } from '../app/commands/commands.mjs';
import { bindCommands } from '../app/commands/run.mjs';
import {
  commandMenu, buildCommandRequest, parseCommandReply, checkCommand, ruleCommand, interpret, executePlan, CommandBarError,
} from '../app/ai/command-bar.mjs';
import { modelContextOf, registerWebMcpTools, toolFor, hasConfirmationHook } from '../app/agent/webmcp.mjs';
import { fakeChat } from './v1x-svc-helpers.mjs';

// ----------------------------------------------------------- command bar ----

test('command menu: read and reversible only, one line each', () => {
  const menu = commandMenu();
  assert.ok(menu.length > 30);
  assert.equal(menu.some(c => commandByName.get(c.name).scope === 'destructive'), false);
  assert.equal(menu.some(c => c.name === 'track.edit_tags' || c.name === 'playlist.delete'), false);
  assert.ok(menu.every(c => c.description.length <= 160));
  const body = buildCommandRequest('shuffle my 5-star jazz', menu);
  assert.match(body.messages[0].content, /- queue\.shuffle: .* input \{ mode\?: "off"\|"tracks"\|"albums" \}/);
  assert.equal(body.messages[0].content.includes('track.edit_tags'), false);
  assert.match(body.messages[1].content, /```request\n"shuffle my 5-star jazz"\n```/);
  assert.deepEqual(body.response_format.json_schema.schema.properties.name.enum, menu.map(c => c.name));
});

test('command reply: validated against the schema; destructive refused', () => {
  assert.deepEqual(parseCommandReply('{"name":"player.seek","input":{"percent":50}}'), { name: 'player.seek', input: { percent: 50 } });
  assert.deepEqual(parseCommandReply({ choices: [{ message: { content: 'ok ```json\n{"name":"player.next"}\n```' } }] }), { name: 'player.next', input: {} });
  assert.throws(() => parseCommandReply('{"name":"player.seek","input":{"percent":500}}'), e => e.code === 'invalid-input');
  assert.throws(() => parseCommandReply('{"name":"playlist.delete","input":{"name":"x"}}'), e => e.code === 'refused');
  assert.throws(() => parseCommandReply('{"name":"rm.rf","input":{}}'), e => e.code === 'not-found');
  assert.throws(() => parseCommandReply('no'), e => e.code === 'no-match');
  assert.throws(() => checkCommand({ name: 'player.next', input: {} }, []), e => e.code === 'refused');
});

test('rules: fixed phrases map to commands without a model', () => {
  const one = t => ruleCommand(t).steps[0];
  assert.deepEqual(one('Play'), { name: 'player.play', input: {} });
  assert.deepEqual(one('pause.'), { name: 'player.pause', input: {} });
  assert.deepEqual(one('next'), { name: 'player.next', input: {} });
  assert.deepEqual(one('shuffle on'), { name: 'queue.shuffle', input: { mode: 'tracks' } });
  assert.deepEqual(one('shuffle off'), { name: 'queue.shuffle', input: { mode: 'off' } });
  assert.deepEqual(one('repeat one'), { name: 'queue.repeat', input: { mode: 'one' } });
  assert.deepEqual(one('volume 40%'), { name: 'player.volume', input: { level: 0.4 } });
  assert.deepEqual(one('mute'), { name: 'player.mute', input: { muted: true } });
  assert.deepEqual(ruleCommand('play some Miles Davis'), { steps: [{ name: 'library.search', input: { query: 'miles davis', limit: 50 } }], followUp: 'queue.set' });
  assert.equal(ruleCommand('make me a sandwich'), null);
  // Every rule output passes the real schema.
  for (const t of ['play', 'pause', 'next', 'previous', 'shuffle', 'shuffle albums', 'unshuffle', 'repeat', 'repeat off', 'mute', 'unmute', 'volume 100', 'status', 'undo', 'clear queue', 'play jazz']) {
    const plan = ruleCommand(t);
    assert.ok(plan, t);
    for (const s of plan.steps) checkCommand(s);
  }
});

test('interpret: simple phrases skip the model; others use it; failures fall back', async () => {
  const chat = fakeChat('{"name":"queue.repeat","input":{"mode":"all"}}');
  assert.deepEqual(await interpret({ text: 'next', chat }), { path: 'rules', plan: { steps: [{ name: 'player.next', input: {} }] }, error: null });
  assert.equal(chat.bodies.length, 0);
  const viaModel = await interpret({ text: 'keep this going forever', chat });
  assert.deepEqual([viaModel.path, viaModel.plan.steps[0]], ['model', { name: 'queue.repeat', input: { mode: 'all' } }]);
  const search = await interpret({ text: 'play the last album I added', chat: fakeChat('{"name":"library.search","input":{"query":"last album"}}') });
  assert.equal(search.plan.followUp, 'queue.set');
  const fallback = await interpret({ text: 'play jazz', chat: fakeChat(new Error('no host')) });
  assert.deepEqual([fallback.path, fallback.plan.followUp], ['model-failed-then-rules', 'queue.set']);
  await assert.rejects(interpret({ text: 'delete my playlist', chat: fakeChat('{"name":"playlist.delete","input":{"name":"a"}}') }), e => e.code === 'refused');
  await assert.rejects(interpret({ text: 'do a barrel roll' }), e => e instanceof CommandBarError && e.code === 'no-match');
  await assert.rejects(interpret({ text: '   ' }), e => e.code === 'empty');
});

test('executePlan: search then queue.set through the runner', async () => {
  const calls = [];
  const run = async (name, input) => {
    calls.push([name, input]);
    if (name === 'library.search') return input.query === 'none' ? { tracks: [], total: 0 } : { tracks: [{ id: 'a' }, { id: 'b' }], total: 2 };
    return { ok: true };
  };
  await executePlan({ steps: [{ name: 'library.search', input: { query: 'jazz' } }], followUp: 'queue.set' }, run);
  assert.deepEqual(calls[1], ['queue.set', { ids: ['a', 'b'], startIndex: 0, play: true }]);
  await assert.rejects(executePlan({ steps: [{ name: 'library.search', input: { query: 'none' } }], followUp: 'queue.set' }, run), e => e.code === 'no-match');
  // With the real runner, queue.set input validates.
  const real = bindCommands({ 'library.search': () => ({ tracks: [{ id: 'x' }] }), 'queue.set': input => input });
  assert.deepEqual(await executePlan(ruleCommand('play x'), real), { ids: ['x'], startIndex: 0, play: true });
});

// ---------------------------------------------------------------- webmcp ----

function fakeModelContext({ confirm = false, legacy = false } = {}) {
  const tools = new Map();
  const mc = {
    tools,
    async registerTool(tool, opts) {
      if (tools.has(tool.name)) throw new Error('InvalidStateError');
      tools.set(tool.name, tool);
      opts?.signal?.addEventListener('abort', () => tools.delete(tool.name));
    },
  };
  if (confirm) mc.requestUserInteraction = async fn => fn();
  if (legacy) mc.unregisterTool = name => tools.delete(name);
  return mc;
}

test('webmcp: no-op when the browser has no model context', async () => {
  const r = await registerWebMcpTools({ run: () => {}, env: { document: {}, navigator: {} } });
  assert.deepEqual([r.available, r.registered.length], [false, 0]);
  r.unregister();
  assert.equal(modelContextOf({}), null);
});

test('webmcp: read and reversible commands register; destructive skipped without a hook', async () => {
  const mc = fakeModelContext();
  const r = await registerWebMcpTools({ run: async () => 1, env: { document: { modelContext: mc } } });
  const destructive = COMMANDS.filter(c => c.scope === 'destructive').map(c => c.name);
  assert.equal(r.registered.length, COMMANDS.length - destructive.length);
  assert.deepEqual(r.skipped.map(s => s.name).sort(), destructive.sort());
  const seek = mc.tools.get('player.seek');
  assert.equal(seek.title, 'Seek');
  assert.deepEqual(seek.inputSchema, commandByName.get('player.seek').input);
  assert.equal(mc.tools.get('queue.read').annotations.readOnlyHint, true);
  assert.equal(seek.annotations.readOnlyHint, false);
  r.unregister();
  assert.equal(mc.tools.size, 0);
});

test('webmcp: navigator.modelContext and a confirmation hook register destructive ones too', async () => {
  const mc = fakeModelContext({ confirm: true, legacy: true });
  assert.equal(hasConfirmationHook(mc), true);
  const r = await registerWebMcpTools({ run: async () => 1, env: { navigator: { modelContext: mc } } });
  assert.equal(r.registered.length, COMMANDS.length);
  assert.equal(mc.tools.get('track.edit_tags').annotations.consequentialHint, true);
  r.unregister();
  assert.equal(mc.tools.size, 0);
});

test('webmcp: execute calls run with validation and returns MCP-style content', async () => {
  const run = bindCommands({ 'player.seek': input => ({ at: input.percent }) });
  const tool = toolFor(commandByName.get('player.seek'), run);
  assert.deepEqual(await tool.execute({ percent: 25 }, { signal: new AbortController().signal }), { content: [{ type: 'text', text: '{"at":25}' }] });
  const bad = await tool.execute({ percent: 900 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /\[invalid-input\]/);
  // Destructive through the runner still needs the in-page confirm.
  const runD = bindCommands({ 'playlist.delete': () => 'gone' }, { confirm: async () => false });
  const del = await toolFor(commandByName.get('playlist.delete'), runD).execute({ name: 'x' });
  assert.match(del.content[0].text, /\[declined\]/);
});

test('webmcp: a registration error skips that tool and keeps the rest', async () => {
  const mc = fakeModelContext();
  const orig = mc.registerTool;
  mc.registerTool = async (tool, opts) => { if (tool.name === 'player.play') throw new Error('nope'); return orig(tool, opts); };
  const r = await registerWebMcpTools({ run: async () => 1, env: { document: { modelContext: mc } } });
  assert.deepEqual(r.skipped.find(s => s.name === 'player.play'), { name: 'player.play', reason: 'nope' });
  assert.ok(r.registered.includes('player.pause'));
});
