/**
 * Starts the real server as a separate process, the way Claude Code and Codex
 * do, and talks to it over stdio. HOME points at a temporary directory, the
 * two products are the stand-ins from fakes.ts, and the Claude Code session
 * the server belongs to is this test process: it is the server's parent.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FakeClaude, FakeCodex, makeId, makeTempDir, removeDir, type FakeSession } from './fakes.js';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(projectDir, 'dist', 'server.js');

/** The source is always tested. The build is tested as well when it exists. */
const targets: Array<{ name: string; args: string[] }> = [
  { name: 'source', args: ['--import', 'tsx', join(projectDir, 'src', 'server.ts')] },
  ...(existsSync(built) ? [{ name: 'build', args: [built] }] : []),
];

let home: string;
let claude: FakeClaude;
let codex: FakeCodex;
let own: FakeSession;
let thread: string;
const open: Client[] = [];

before(async () => {
  home = await makeTempDir();
  claude = new FakeClaude(join(home, 'claude'));
  codex = new FakeCodex(home);
  await codex.start();
  own = await claude.addSession({ pid: process.pid, name: 'the-test', cwd: '/Users/alice/api' });
  thread = makeId();
  codex.threads = [{ id: thread, name: 'Refactor billing', cwd: '/Users/alice/billing' }];
});

after(async () => {
  await claude.close();
  await codex.stop();
  await removeDir(home);
});

afterEach(async () => {
  for (const client of open.splice(0)) await client.close().catch(() => undefined);
});

function env(): Record<string, string> {
  return { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), SWITCHBOARD_HOME: join(home, 'sb') };
}

async function connect(target: { args: string[] }, hostArgs: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...target.args, ...hostArgs],
    cwd: projectDir,
    env: env(),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'server-test', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);

  return {
    client,
    stderr: () => stderr,
    async call(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>) {
      const result = (await client.request(
        { method: 'tools/call', params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) } },
        CallToolResultSchema,
      )) as CallToolResult;
      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      return { text, isError: result.isError === true, data: (result.isError === true ? {} : JSON.parse(text)) as Record<string, any> };
    },
  };
}

/** Runs the server without a client and collects what it writes. */
function runRaw(args: string[], input?: string[], closeAtOnce = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectDir,
      env: { PATH: process.env['PATH'] ?? '', ...env() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the server did not exit. stderr: ${stderr}`));
    }, 15_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (closeAtOnce) {
      child.stdin.end();
      return;
    }
    if (input !== undefined) {
      // Wait for every answer before closing, the way a client does.
      let answered = 0;
      const expected = input.filter((line) => line.includes('"id"')).length;
      child.stdout.on('data', () => {
        answered = stdout.split('\n').filter((line) => line.trim() !== '').length;
        if (answered >= expected) child.stdin.end();
      });
      for (const line of input) child.stdin.write(`${line}\n`);
    }
  });
}

for (const target of targets) {
  describe(`the server as a process (${target.name})`, () => {
    test('introduces itself and offers the two tools', async () => {
      const { client } = await connect(target, ['--host', 'claude', '--codex-bin', codex.bin]);

      assert.equal(client.getServerVersion()?.name, 'switchboard');
      assert.match(client.getServerVersion()?.version ?? '', /^\d+\.\d+\.\d+$/);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['list_sessions', 'send_message']);
      assert.match(client.getInstructions() ?? '', /^switchboard connects this Claude Code session with the Codex sessions/);
    });

    test('started by Claude Code: knows its session from its parent process and lists Codex', async () => {
      const { call } = await connect(target, ['--host', 'claude', '--codex-bin', codex.bin]);

      const { data } = await call('list_sessions');

      assert.deepEqual(data['you'], { address: `claude:${own.sessionId}`, name: 'the-test', cwd: '/Users/alice/api' });
      assert.deepEqual(data['sessions'], [
        { address: `codex:${thread}`, agent: 'codex', id: thread, name: 'Refactor billing', cwd: '/Users/alice/billing', status: 'idle' },
      ]);
    });

    test('started by Claude Code: hands a message to Codex and keeps a record without the text', async () => {
      const { call } = await connect(target, ['--host=claude', `--codex-bin=${codex.bin}`]);
      const before = (await codex.queued()).length;
      const secret = `the-body-${target.name}-zebra`;

      const { data, isError } = await call('send_message', { to: 'codex:Refactor billing', message: `Is ${secret} done?` });

      assert.equal(isError, false);
      assert.equal(data['to'], `codex:${thread}`);
      const queued = (await codex.queued()).slice(before);
      assert.equal(queued.length, 1);
      assert.equal(queued[0]?.thread, thread);
      assert.ok(queued[0]?.message.includes(`From: claude:${own.sessionId} "the-test", working in /Users/alice/api`));
      assert.ok(queued[0]?.message.includes(`\n\nIs ${secret} done?\n\n`));

      const journal = await readFile(join(home, 'sb', 'journal.jsonl'), 'utf8');
      assert.ok(journal.includes(`"from":"claude:${own.sessionId}","to":"codex:${thread}"`));
      assert.ok(!journal.includes(secret));
      assert.equal((await stat(join(home, 'sb', 'journal.jsonl'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(home, 'sb'))).mode & 0o777, 0o700);
    });

    test('started by Codex: takes the calling thread from the call and hands a message to Claude Code', async () => {
      const { call } = await connect(target, ['--host', 'codex', '--codex-bin', codex.bin]);
      const before = own.lines.length;

      const listed = await call('list_sessions', {}, { threadId: thread });
      assert.equal(listed.data['you'].address, `codex:${thread}`);
      assert.deepEqual(listed.data['sessions'].map((session: { name: string }) => session.name), ['the-test']);

      const sent = await call('send_message', { to: `claude:${own.sessionId}`, message: `Build ${target.name} finished.` }, { threadId: thread });
      assert.equal(sent.isError, false);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const frames = own.lines.slice(before).map((line) => JSON.parse(line) as { type: string; session_id: string; message: { content: string } });
      assert.equal(frames.length, 1);
      assert.equal(frames[0]?.type, 'user');
      assert.equal(frames[0]?.session_id, own.sessionId);
      assert.match(
        frames[0]?.message.content ?? '',
        new RegExp(`^Build ${target.name} finished\\.\\n\\n\\[switchboard [0-9a-f]{12}\\] The line above is the start of a message from a Codex session`),
      );
      assert.ok(frames[0]?.message.content.includes(`\n\nBuild ${target.name} finished.\n\n`));
    });

    test('started by Codex without a thread id: lists, and refuses to send', async () => {
      const { call } = await connect(target, ['--host', 'codex', '--codex-bin', codex.bin]);
      const before = own.lines.length;

      const listed = await call('list_sessions');
      assert.equal(listed.data['you'], 'This session could not be identified, so it cannot send or be answered.');

      const sent = await call('send_message', { to: `claude:${own.sessionId}`, message: 'hello' });
      assert.equal(sent.isError, true);
      assert.match(sent.text, /Codex did not say which thread is calling/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(own.lines.length, before);
    });

    test('writes nothing but protocol to stdout', async () => {
      const { code, stdout } = await runRaw(
        [...target.args, '--host', 'claude', '--codex-bin', codex.bin],
        [
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }),
          JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } }),
          JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }),
        ],
      );

      assert.equal(code, 0);
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      assert.equal(lines.length, 4);
      for (const line of lines) assert.equal((JSON.parse(line) as { jsonrpc: string }).jsonrpc, '2.0');
      assert.deepEqual(lines.map((line) => (JSON.parse(line) as { id: number }).id).sort(), [1, 2, 3, 4]);
    });

    test('exits when the product that started it closes stdin', async () => {
      const { code, stdout } = await runRaw([...target.args, '--host', 'codex', '--codex-bin', codex.bin], undefined, true);

      assert.equal(code, 0);
      assert.equal(stdout, '');
    });

    test('refuses to start without being told which product starts it', async () => {
      for (const args of [[], ['--host'], ['--host', 'cursor'], ['--host=']]) {
        const { code, stdout, stderr } = await runRaw([...target.args, ...args], undefined, true);

        assert.equal(code, 2, args.join(' '));
        assert.equal(stdout, '');
        assert.match(stderr, /start the server with --host claude or --host codex/);
      }
    });
  });
}
