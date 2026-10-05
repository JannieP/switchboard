import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { claudeSessionsDir, deliverToClaude, KNOWN_PEER_PROTOCOL, listClaudeSessions, withoutDuplicates } from '../src/claude.js';
import { BridgeError } from '../src/text.js';
import { FakeClaude, makeId, makeTempDir, removeDir } from './fakes.js';

let root: string;
let claude: FakeClaude;

beforeEach(async () => {
  root = await makeTempDir();
  claude = new FakeClaude(root);
});

afterEach(async () => {
  await claude.close();
  await removeDir(root);
});

/** Waits until the inbox has received what was sent. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('finding Claude Code sessions', () => {
  test('lists the running sessions with what is needed to choose one', async () => {
    const worker = await claude.addSession({ pid: 4242, name: 'api-worker', cwd: '/Users/alice/api', status: 'busy' });
    await claude.addSession({ pid: 4100, name: 'Docs' });

    const sessions = await listClaudeSessions(claude.options);

    assert.deepEqual(
      sessions.map((session) => session.name),
      ['api-worker', 'Docs'],
    );
    assert.deepEqual(sessions[0], {
      pid: 4242,
      sessionId: worker.sessionId,
      name: 'api-worker',
      cwd: '/Users/alice/api',
      status: 'busy',
      kind: 'interactive',
      version: '2.1.286',
      peerProtocol: 1,
      socketPath: worker.socketPath,
      updatedAt: 1791174823620,
    });
  });

  test('is empty when Claude Code has never run here', async () => {
    assert.deepEqual(await listClaudeSessions({ sessionsDir: join(root, 'nowhere') }), []);
  });

  test('leaves out a session whose process has ended', async () => {
    await claude.addSession({ pid: 4242 });
    await claude.addSession({ pid: 4243 });
    claude.alive.delete(4243);

    assert.deepEqual((await listClaudeSessions(claude.options)).map((session) => session.pid), [4242]);
  });

  test('uses the real process table when nothing else is given', async () => {
    await claude.addSession({ pid: process.pid, name: 'this-test' });
    await claude.addSession({ pid: 2_000_000_000, name: 'nobody' });

    const sessions = await listClaudeSessions({ sessionsDir: claude.sessionsDir });
    assert.deepEqual(sessions.map((session) => session.name), ['this-test']);
  });

  test('leaves out files that are not session files', async () => {
    const good = await claude.addSession({ pid: 4242 });
    await claude.addSession({ pid: 4301, file: { pid: 9999 } });
    await claude.addSession({ pid: 4302, file: { sessionId: 'not-an-id' } });
    await claude.addSession({ pid: 4303, file: { messagingSocketPath: undefined } });
    await claude.addSession({ pid: 4304, file: { messagingSocketPath: 'relative/path.sock' } });
    for (const pid of [4301, 4302, 4303, 4304, 4305, 4306, 4307]) claude.alive.add(pid);
    await claude.writeFile(4305, 'not json');
    await claude.writeFile(4306, JSON.stringify(['a list']));
    await claude.writeFile(4307, JSON.stringify({ pid: 4307, sessionId: makeId(), messagingSocketPath: good.socketPath, padding: 'x'.repeat(70_000) }));
    await claude.writeFile('notes', '{}');
    await claude.writeFile('12ab', '{}');
    await mkdir(join(claude.sessionsDir, '4308.json'));

    assert.deepEqual((await listClaudeSessions(claude.options)).map((session) => session.pid), [4242]);
  });

  test('leaves out a session whose inbox is gone, is not a socket, or is open to others', async () => {
    await claude.addSession({ pid: 4242 });
    const gone = await claude.addSession({ pid: 4401 });
    const open = await claude.addSession({ pid: 4402, socketMode: 0o666 });
    const group = await claude.addSession({ pid: 4403, socketMode: 0o660 });
    const plain = join(root, 'plain.sock');
    await writeFile(plain, 'not a socket', { mode: 0o600 });
    await claude.addSession({ pid: 4404, file: { messagingSocketPath: plain } });
    await rm(gone.socketPath);

    assert.deepEqual((await listClaudeSessions(claude.options)).map((session) => session.pid), [4242]);
    // The checks are on the socket itself, not on what the file says.
    assert.equal(open.lines.length + group.lines.length, 0);
  });

  test('leaves out sessions of another system user', async () => {
    await claude.addSession({ pid: 4242 });
    const mine = process.getuid?.() ?? 0;

    assert.equal((await listClaudeSessions({ ...claude.options, uid: mine })).length, 1);
    assert.equal((await listClaudeSessions({ ...claude.options, uid: mine + 1 })).length, 0);
  });

  test('keeps a session without a name or a protocol version, so that it can be explained', async () => {
    await claude.addSession({ pid: 4242, name: '', peerProtocol: null, file: { status: undefined, kind: undefined } });
    const [session] = await listClaudeSessions(claude.options);

    assert.equal(session?.name, '');
    assert.equal(session?.peerProtocol, undefined);
    assert.equal(session?.status, 'unknown');
    assert.equal(session?.kind, 'unknown');
  });

  test('keeps both processes of a session that is registered twice, and can tell which one is in use', async () => {
    // What a suspended "claude --resume" leaves behind while the session goes on in a second process.
    const suspended = await claude.addSession({ pid: 4100, name: 'burrow-work', status: 'idle', updatedAt: 1790860837796 });
    const inUse = await claude.addSession({ pid: 4242, name: 'burrow-work', status: 'busy', sessionId: suspended.sessionId, updatedAt: 1791174823620 });
    const other = await claude.addSession({ pid: 4300, name: 'docs' });

    const all = await listClaudeSessions(claude.options);
    assert.deepEqual(all.map((session) => session.pid), [4100, 4242, 4300]);

    const unique = withoutDuplicates(all);
    assert.deepEqual(unique.map((session) => [session.pid, session.sessionId]), [[4242, inUse.sessionId], [4300, other.sessionId]]);
  });

  test('takes the later process when two of one session reported at the same moment', () => {
    const base = { sessionId: 'x', name: '', cwd: '', status: 'idle', kind: 'interactive', version: '', peerProtocol: 1, socketPath: '/s', updatedAt: 5 };

    assert.deepEqual(withoutDuplicates([{ ...base, pid: 9 }, { ...base, pid: 12 }, { ...base, pid: 3 }]).map((session) => session.pid), [12]);
    assert.deepEqual(withoutDuplicates([{ ...base, pid: 9, updatedAt: undefined }, { ...base, pid: 3, updatedAt: 1 }]).map((session) => session.pid), [3]);
    assert.deepEqual(withoutDuplicates([]), []);
  });

  test('looks where Claude Code keeps its files', () => {
    assert.match(claudeSessionsDir({}), /\/\.claude\/sessions$/);
    assert.equal(claudeSessionsDir({ CLAUDE_CONFIG_DIR: '/custom/claude' }), '/custom/claude/sessions');
    assert.match(claudeSessionsDir({ CLAUDE_CONFIG_DIR: '' }), /\/\.claude\/sessions$/);
  });
});

describe('handing a message to a Claude Code session', () => {
  test('writes one line of JSON to the inbox, addressed to that session', async () => {
    const target = await claude.addSession({ pid: 4242 });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);

    await deliverToClaude(session, { from: 'codex: reviewer', text: 'Line one\nLine "two" — ünïcode' }, claude.options);
    await settled();

    assert.equal(target.lines.length, 1);
    assert.deepEqual(JSON.parse(target.lines[0] ?? ''), {
      type: 'user',
      from: 'codex: reviewer',
      session_id: target.sessionId,
      message: { content: 'Line one\nLine "two" — ünïcode' },
    });
  });

  test('sends no auth line and claims no permission mode, so the session applies its rules for a stranger', async () => {
    const target = await claude.addSession({ pid: 4242 });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);

    await deliverToClaude(session, { from: 'codex-1', text: 'hello' }, claude.options);
    await settled();

    const frame = JSON.parse(target.lines[0] ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(frame).sort(), ['from', 'message', 'session_id', 'type']);
    assert.ok(!target.lines.join('\n').includes('"auth"'));
  });

  test('sends nothing to a session that speaks another version of the protocol', async () => {
    const newer = await claude.addSession({ pid: 4242, peerProtocol: KNOWN_PEER_PROTOCOL + 1 });
    const older = await claude.addSession({ pid: 4243, peerProtocol: null });

    for (const session of await listClaudeSessions(claude.options)) {
      await assert.rejects(
        deliverToClaude(session, { from: 'codex-1', text: 'hello' }, claude.options),
        (err: unknown) => err instanceof BridgeError && err.kind === 'unsupported' && /only knows protocol 1\. Nothing was sent\./.test(err.message),
      );
    }
    await settled();
    assert.equal(newer.lines.length + older.lines.length, 0);
  });

  test('says so when the session ended after it was listed', async () => {
    const target = await claude.addSession({ pid: 4242 });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);
    await claude.close();
    await rm(target.socketPath, { force: true });

    await assert.rejects(
      deliverToClaude(session, { from: 'codex-1', text: 'hello' }, claude.options),
      (err: unknown) => err instanceof BridgeError && err.kind === 'not_found' && /no longer running/.test(err.message),
    );
  });

  test('does not write to an inbox that was opened up to others after the listing', async () => {
    const target = await claude.addSession({ pid: 4242 });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);
    await chmod(target.socketPath, 0o666);

    await assert.rejects(deliverToClaude(session, { from: 'codex-1', text: 'hello' }, claude.options), /no longer running/);
    await settled();
    assert.equal(target.lines.length, 0);
  });

  test('is done once the line is written, also when the session is slow to hang up', async () => {
    const target = await claude.addSession({ pid: 4242, lingers: true });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);

    const started = Date.now();
    await deliverToClaude(session, { from: 'codex-1', text: 'hello' }, { ...claude.options, timeoutMs: 5000 });

    assert.ok(Date.now() - started < 1000);
    await settled();
    assert.equal(target.lines.length, 1);
  });

  test('carries a long message whole', async () => {
    const target = await claude.addSession({ pid: 4242 });
    const [session] = await listClaudeSessions(claude.options);
    assert.ok(session !== undefined);
    const text = 'x'.repeat(200_000);

    await deliverToClaude(session, { from: 'codex-1', text }, claude.options);
    await settled();

    assert.equal((JSON.parse(target.lines[0] ?? '{}') as { message: { content: string } }).message.content.length, 200_000);
  });
});
