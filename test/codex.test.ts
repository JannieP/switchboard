import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { codexDaemon, listCodexSessions, queueForCodex, surveyCodex } from '../src/codex.js';
import { BridgeError } from '../src/text.js';
import { CHECK_TEXT, FakeCodex, makeId, makeTempDir, removeDir } from './fakes.js';

let root: string;
let codex: FakeCodex;

beforeEach(async () => {
  root = await makeTempDir();
  codex = new FakeCodex(root);
  await codex.start();
});

afterEach(async () => {
  await codex.stop();
  await removeDir(root);
});

/** What the connector itself sent to the daemon, apart from what `codex queue` sent. */
function sentByConnector(): Array<{ method: string; params: unknown }> {
  return codex.seen.filter((item) => item.client === 'switchboard').map(({ method, params }) => ({ method, params }));
}

describe('asking Codex about its daemon', () => {
  test('reports a running daemon and where its socket is', async () => {
    assert.deepEqual(await codexDaemon(codex.options), {
      running: true,
      socketPath: codex.socketPath,
      cliVersion: '9.9.9',
      daemonVersion: '9.9.8',
    });
  });

  test('reports a daemon that is not running, or an answer it cannot read, as not running', async () => {
    await codex.setState({ status: 'stopped' });
    assert.equal((await codexDaemon(codex.options)).running, false);

    for (const raw of ['', 'not json', '[]', '{"status":"running"}', '{"status":"running","socketPath":"relative.sock"}']) {
      await codex.setState({ raw });
      assert.equal((await codexDaemon(codex.options)).running, false, raw);
    }
  });

  test('says so when Codex is not installed', async () => {
    await assert.rejects(
      codexDaemon({ codexBin: join(root, 'no-such-codex') }),
      (err: unknown) => err instanceof BridgeError && err.kind === 'unavailable' && /Codex could not be started/.test(err.message),
    );
  });
});

describe('listing Codex sessions', () => {
  test('lists the sessions that are open, newest first', async () => {
    const older = makeId();
    const newer = makeId();
    codex.threads = [
      { id: older, name: 'Refactor billing', preview: 'Please split the billing module', cwd: '/Users/alice/billing', updatedAt: 1791170000 },
      { id: newer, preview: 'Why is the build red?\nIt was green yesterday.', status: { type: 'active', activeFlags: [] }, updatedAt: 1791173600 },
    ];

    assert.deepEqual(await listCodexSessions(codex.options), [
      { id: newer, name: null, preview: 'Why is the build red? It was green yesterday.', cwd: '/Users/alice/work', status: 'active', updatedAt: 1791173600000 },
      { id: older, name: 'Refactor billing', preview: 'Please split the billing module', cwd: '/Users/alice/billing', status: 'idle', updatedAt: 1791170000000 },
    ]);
  });

  test('introduces itself under its own name, asks, and never starts, resumes or queues anything', async () => {
    codex.threads = [{ id: makeId() }, { id: makeId() }];
    await listCodexSessions(codex.options);

    assert.deepEqual([...new Set(codex.paths)], ['/rpc']);
    assert.deepEqual(
      sentByConnector().map((item) => item.method),
      ['initialize', 'initialized', 'thread/loaded/list', 'thread/read', 'thread/read'],
    );
    assert.deepEqual(sentByConnector()[0]?.params, {
      clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.0.0-test' },
      capabilities: {},
    });
    for (const item of sentByConnector().filter((entry) => entry.method === 'thread/read')) {
      assert.equal((item.params as { includeTurns: boolean }).includeTurns, false);
    }
  });

  test('answers none of the requests the daemon sends to its clients', async () => {
    codex.threads = [{ id: makeId() }];
    await listCodexSessions(codex.options);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The fake asks every client to approve a command, as the real one may.
    assert.deepEqual(codex.answersFromClient, []);
  });

  test('leaves out the helper sessions Codex starts for another session', async () => {
    const main = makeId();
    codex.threads = [
      { id: main, name: 'main' },
      { id: makeId(), name: 'child', parentThreadId: main },
      { id: makeId(), name: 'review', source: { subAgent: 'review' } },
      { id: makeId(), name: 'spawned', source: 'subAgentThreadSpawn' },
      { id: makeId(), name: 'takes no input', canAcceptDirectInput: false },
      { id: makeId(), name: 'from the editor', source: 'vscode' },
      { id: makeId(), name: 'older codex', canAcceptDirectInput: null },
    ];

    assert.deepEqual((await listCodexSessions(codex.options)).map((session) => session.name).sort(), ['from the editor', 'main', 'older codex']);
  });

  test('leaves out the short-lived threads Codex makes for its own use', async () => {
    // What the real daemon holds right after a window opens a session: the session, and a thread that thinks up its title.
    codex.threads = [
      { id: makeId(), name: 'Reply with READY', source: 'vscode' },
      { id: makeId(), name: null, preview: '', source: 'vscode', ephemeral: true },
    ];

    assert.deepEqual((await listCodexSessions(codex.options)).map((session) => session.name), ['Reply with READY']);
  });

  test('skips a session that closed between the two questions', async () => {
    const stays = makeId();
    const closes = makeId();
    codex.threads = [{ id: stays }, { id: closes }];
    codex.unreadable.add(closes);

    assert.deepEqual((await listCodexSessions(codex.options)).map((session) => session.id), [stays]);
  });

  test('keeps names and previews to one short line', async () => {
    codex.threads = [{ id: makeId(), name: `  Line one\nline two ${'x'.repeat(300)}`, preview: 'p'.repeat(500) }];
    const [session] = await listCodexSessions(codex.options);

    assert.ok(session?.name?.startsWith('Line one line two xxx'));
    assert.equal(session?.name?.length, 120);
    assert.equal(session?.preview.length, 80);
  });

  test('is empty, and talks to nothing, when the daemon is not running', async () => {
    await codex.setState({ status: 'stopped' });

    assert.deepEqual(await surveyCodex(codex.options), { sessions: [], tookOurName: false, codexWentFirst: true });
    assert.deepEqual(codex.paths, []);
    assert.deepEqual(await codex.queueCalls(), []);
  });

  test('gives up on a daemon that does not answer', async () => {
    codex.silent = true;

    await assert.rejects(
      listCodexSessions({ ...codex.options, rpcTimeoutMs: 150 }),
      (err: unknown) => err instanceof BridgeError && err.kind === 'unavailable' && /did not answer/.test(err.message),
    );
  });

  test('gives up when the socket is gone', async () => {
    await codex.stop();

    await assert.rejects(listCodexSessions(codex.options), (err: unknown) => err instanceof BridgeError && err.kind === 'unavailable');
  });
});

describe('letting Codex introduce itself to its daemon first', () => {
  test('has Codex its own client go first on a daemon nobody has talked to, so the daemon keeps Codex its name', async () => {
    codex.threads = [{ id: makeId() }];

    const survey = await surveyCodex(codex.options);

    assert.deepEqual(codex.inits, ['codex-tui', 'switchboard']);
    assert.match(codex.userAgent, /^codex-tui\//);
    assert.equal(survey.tookOurName, false);
    assert.equal(survey.codexWentFirst, true);
  });

  test('does that with a session id that cannot exist, so nothing is queued', async () => {
    const real = makeId();
    codex.threads = [{ id: real }];

    await surveyCodex(codex.options);

    const calls = await codex.queueCalls();
    assert.equal(calls.length, 1);
    const [command, flag, id, message] = calls[0]?.argv ?? [];
    assert.deepEqual([command, flag, message], ['queue', '--thread', `--message=${CHECK_TEXT}`]);
    assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(id, real);
    assert.deepEqual(await codex.queued(), []);
  });

  test('does it once for each start of the daemon', async () => {
    await surveyCodex(codex.options);
    await surveyCodex(codex.options);
    await listCodexSessions(codex.options);
    assert.equal(await codex.checks(), 1);
    assert.deepEqual(codex.inits, ['codex-tui', 'switchboard', 'switchboard', 'switchboard']);

    await codex.restart();
    const survey = await surveyCodex(codex.options);

    assert.equal(await codex.checks(), 2);
    assert.deepEqual(codex.inits.slice(4), ['codex-tui', 'switchboard']);
    assert.equal(survey.tookOurName, false);
  });

  test('remembers it in a private file that holds nothing about sessions', async () => {
    codex.threads = [{ id: makeId(), name: 'Secret project', cwd: '/Users/alice/secret' }];
    await surveyCodex(codex.options);

    const file = join(codex.options.stateDir, 'codex-daemon.json');
    const note = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    assert.deepEqual(Object.keys(note).sort(), ['codexIntroducedItself', 'daemon']);
    assert.ok(String(note['daemon']).startsWith(`${codex.socketPath}|`));
    assert.ok(!JSON.stringify(note).includes('Secret'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(codex.options.stateDir)).mode & 0o777, 0o700);
  });

  test('does not trust a note about another daemon, or a note it cannot read', async () => {
    await surveyCodex(codex.options);
    const file = join(codex.options.stateDir, 'codex-daemon.json');

    for (const content of ['{"daemon":"/somewhere/else.sock|1|2"}', 'not json', '[]', '{}']) {
      await codex.restart();
      await writeFile(file, content);
      const before = await codex.checks();

      await surveyCodex(codex.options);

      assert.equal(await codex.checks(), before + 1, content);
      assert.match(codex.userAgent, /^codex-tui\//, content);
    }
  });

  test('says so when the daemon took the name of this connector after all', async () => {
    // "codex queue" fails before it reaches the daemon, and no Codex window ever talked to this daemon.
    await codex.setState({ status: 'running', queueFails: 'Error: cannot queue through an embedded app server while a local app-server daemon is running' });
    codex.threads = [{ id: makeId(), name: 'main' }];

    const survey = await surveyCodex(codex.options);

    assert.deepEqual(codex.inits, ['switchboard']);
    assert.equal(survey.codexWentFirst, false);
    assert.equal(survey.tookOurName, true);
    assert.deepEqual(survey.sessions.map((session) => session.name), ['main']);
  });

  test('does not remember a check that did not reach the daemon, and tries again next time', async () => {
    await codex.setState({ status: 'running', queueFails: 'Error: something else went wrong' });
    await surveyCodex(codex.options);
    await surveyCodex(codex.options);

    assert.equal(await codex.checks(), 2);
    await assert.rejects(stat(join(codex.options.stateDir, 'codex-daemon.json')));
  });

  test('reports no harm when a Codex window had already talked to the daemon', async () => {
    // A Codex window is there first, as it is whenever a window starts the daemon.
    const thread = makeId();
    codex.threads = [{ id: thread }];
    await queueForCodex(thread, 'from the user', codex.options);
    await codex.setState({ status: 'running', queueFails: 'Error: something else went wrong' });

    const survey = await surveyCodex(codex.options);

    assert.equal(survey.codexWentFirst, false);
    assert.equal(survey.tookOurName, false);
    assert.match(codex.userAgent, /^codex-tui\/.*\(switchboard; 0\.0\.0-test\)$/);
  });

  test('says so when Codex is not installed', async () => {
    const run = async (file: string, args: readonly string[]) =>
      args[0] === 'queue'
        ? { code: null, stdout: '', stderr: '', startError: 'ENOENT' }
        : { code: 0, stdout: JSON.stringify({ status: 'running', socketPath: codex.socketPath }), stderr: '' };

    await assert.rejects(surveyCodex({ ...codex.options, run }), /Codex could not be started/);
    assert.deepEqual(codex.inits, []);
  });
});

describe('handing a message to a Codex session', () => {
  test('queues it with codex queue, for exactly that session', async () => {
    const id = makeId();
    codex.threads = [{ id }, { id: makeId() }];

    const queued = await queueForCodex(id, 'Line one\nLine "two" $HOME `id` — ünïcode', codex.options);

    assert.equal(queued, 'q-1');
    assert.deepEqual(await codex.queued(), [
      {
        thread: id,
        message: 'Line one\nLine "two" $HOME `id` — ünïcode',
        argv: ['queue', '--thread', id, '--message=Line one\nLine "two" $HOME `id` — ünïcode'],
      },
    ]);
  });

  test('passes on a text that looks like an option as text', async () => {
    const id = makeId();
    codex.threads = [{ id }];

    await queueForCodex(id, '--help me with this\n--thread other', codex.options);

    const [entry] = await codex.queued();
    assert.equal(entry?.thread, id);
    assert.equal(entry?.message, '--help me with this\n--thread other');
  });

  test('refuses anything but a session id before running a program', async () => {
    for (const id of ['', 'main', '../x', '--message=x', `${makeId()} --oss`]) {
      await assert.rejects(queueForCodex(id, 'hello', codex.options), (err: unknown) => err instanceof BridgeError && err.kind === 'invalid_input');
    }
    assert.deepEqual(await codex.queueCalls(), []);
  });

  test('says that the session is gone when Codex no longer knows it', async () => {
    await assert.rejects(
      queueForCodex(makeId(), 'hello', codex.options),
      (err: unknown) => err instanceof BridgeError && err.kind === 'not_found' && err.message === 'That Codex session is no longer there. Nothing was sent.',
    );
    assert.deepEqual(await codex.queued(), []);
  });

  test('says why when Codex refuses, in one line and without the wrapping', async () => {
    const id = makeId();
    codex.threads = [{ id, ephemeral: true }];

    await assert.rejects(
      queueForCodex(id, 'hello', codex.options),
      (err: unknown) =>
        err instanceof BridgeError &&
        err.kind === 'failed' &&
        err.message === `Codex did not take the message: ephemeral thread does not support queued submissions: ${id} (code -32600). Nothing was sent.`,
    );
  });

  test('keeps to the first line of a longer complaint', async () => {
    await codex.setState({ status: 'running', queueFails: 'Error: No active session found matching the id.\n\nCaused by:\n    0: something long' });

    await assert.rejects(
      queueForCodex(makeId(), 'hello', codex.options),
      (err: unknown) =>
        err instanceof BridgeError && err.kind === 'failed' && err.message === 'Codex did not take the message: No active session found matching the id. Nothing was sent.',
    );
  });

  test('says so when Codex is not installed', async () => {
    await assert.rejects(queueForCodex(makeId(), 'hello', { codexBin: join(root, 'no-such-codex') }), /Codex could not be started/);
  });
});
