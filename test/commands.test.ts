/**
 * The commands a person runs at a terminal. The two products are the stand-ins
 * from fakes.ts, and "claude mcp …" and "codex mcp …" go to a recorder.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { queueForCodex, type CommandResult } from '../src/codex.js';
import { DAEMON_TOOK_OUR_NAME } from '../src/bridge.js';
import { runCli, USAGE, type CommandDeps } from '../src/commands.js';
import { Journal } from '../src/journal.js';
import { FakeClaude, FakeCodex, makeId, makeTempDir, removeDir } from './fakes.js';

const CLAUDE_BIN = '/fake/bin/claude';
const CODEX_BIN = '/fake/other/codex';
const NODE_BIN = '/fake/node/bin/node';

let root: string;
let claude: FakeClaude;
let codex: FakeCodex;
let serverPath: string;

beforeEach(async () => {
  root = await makeTempDir();
  claude = new FakeClaude(root);
  codex = new FakeCodex(root);
  await codex.start();
  serverPath = join(root, 'server.js');
  await writeFile(serverPath, '// the built server\n');
});

afterEach(async () => {
  await claude.close();
  await codex.stop();
  await removeDir(root);
});

interface Ran {
  file: string;
  args: string[];
}

/**
 * Runs one command. `answers` says what the recorded programs answer, by the
 * start of their command line. Anything else succeeds.
 */
async function cli(argv: string[], options: { answers?: Record<string, Partial<CommandResult>>; ctx?: Partial<CommandDeps> } = {}) {
  const lines: string[] = [];
  const ran: Ran[] = [];
  const code = await runCli(argv, {
    deps: { claude: claude.options, codex: codex.options, journal: new Journal(join(root, 'home')) },
    print: (line) => lines.push(line),
    run: async (file, args) => {
      ran.push({ file, args: [...args] });
      const line = [file, ...args].join(' ');
      const key = Object.keys(options.answers ?? {}).find((start) => line.startsWith(start));
      return { code: 0, stdout: '', stderr: '', ...(key === undefined ? {} : options.answers?.[key]) };
    },
    pathEnv: '/nowhere:/fake/bin::/fake/other',
    isExecutable: async (path) => path === CLAUDE_BIN || path === CODEX_BIN,
    nodeBin: NODE_BIN,
    serverPath,
    ...options.ctx,
  });
  return { code, lines, ran, text: lines.join('\n') };
}

describe('usage', () => {
  test('is shown without a command, and that counts as a mistake', async () => {
    assert.deepEqual(await cli([]), { code: 2, lines: [USAGE], ran: [], text: USAGE });
  });

  test('is shown when asked for', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const result = await cli([flag]);
      assert.equal(result.code, 0);
      assert.equal(result.text, USAGE);
    }
  });

  test('names every command', () => {
    for (const command of ['list', 'doctor', 'install', 'uninstall']) assert.match(USAGE, new RegExp(`switchboard ${command}\\b`));
  });

  test('refuses an unknown command or option and runs nothing', async () => {
    const unknown = await cli(['explode']);
    assert.equal(unknown.code, 2);
    assert.ok(unknown.text.startsWith('Unknown command "explode".'));

    for (const argv of [['install', '--force'], ['list', '--dry-run'], ['doctor', 'extra'], ['uninstall', '--dry-run', '--yes']]) {
      const result = await cli(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.ok(result.text.startsWith(`Unknown option for "${argv[0]}".`), argv.join(' '));
      assert.deepEqual(result.ran, []);
    }
  });
});

describe('list', () => {
  test('shows the sessions of both products with what is needed to tell them apart', async () => {
    const worker = await claude.addSession({ pid: 4242, name: 'api-worker', cwd: '/Users/alice/api', status: 'busy' });
    const named = makeId();
    const unnamed = makeId();
    codex.threads = [
      { id: named, name: 'Refactor billing', cwd: '/Users/alice/billing', updatedAt: 1791173600 },
      { id: unnamed, preview: 'Why is the build red?', status: { type: 'active' }, updatedAt: 1791170000 },
    ];

    const { code, lines } = await cli(['list']);

    const wide = `claude:${worker.sessionId}`.length;
    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'Claude Code sessions',
      `  ${'ADDRESS'.padEnd(wide)}  ${'NAME'.padEnd(10)}  STATUS  DIRECTORY`,
      `  claude:${worker.sessionId}  api-worker  busy    /Users/alice/api`,
      '',
      'Codex sessions',
      `  ${'ADDRESS'.padEnd(wide - 1)}  ${'NAME'.padEnd(23)}  STATUS  DIRECTORY`,
      `  codex:${named}  ${'Refactor billing'.padEnd(23)}  idle    /Users/alice/billing`,
      `  codex:${unnamed}  (Why is the build red?)  active  /Users/alice/work`,
    ]);
  });

  test('says so when nothing is running', async () => {
    assert.deepEqual((await cli(['list'])).lines, ['Claude Code: no session is running.', '', 'Codex: no session is running.']);
  });

  test('marks a session that cannot be messaged', async () => {
    await claude.addSession({ pid: 4242, name: 'from-the-future', peerProtocol: 2 });

    assert.match((await cli(['list'])).text, /from-the-future {2}cannot be messaged {2}\/Users\/alice\/project/);
  });

  test('warns when the Codex background service took the name of this connector', async () => {
    await codex.setState({ status: 'running', queueFails: 'Error: no such command' });
    codex.threads = [{ id: makeId(), name: 'main' }];

    const { code, lines } = await cli(['list']);

    assert.equal(code, 0);
    assert.equal(lines.at(-1), `Warning: ${DAEMON_TOOK_OUR_NAME}`);
  });

  test('still shows one product when the other cannot be asked', async () => {
    await claude.addSession({ pid: 4242, name: 'api-worker' });

    const { code, lines } = await cli(['list'], {
      ctx: { deps: { claude: claude.options, codex: { codexBin: join(root, 'no-such-codex') }, journal: new Journal(join(root, 'home')) } },
    });

    assert.equal(code, 0);
    assert.equal(lines[0], 'Claude Code sessions');
    assert.match(lines.at(-1) ?? '', /^Codex: Codex could not be started \(.*no-such-codex\)\. Is it installed and on the PATH\?$/);
  });

  test('changes nothing: no message, no registration, no journal', async () => {
    const worker = await claude.addSession({ pid: 4242 });
    codex.threads = [{ id: makeId() }];

    const { ran } = await cli(['list']);

    assert.deepEqual(ran, []);
    assert.deepEqual(worker.lines, []);
    assert.deepEqual(await codex.queued(), []);
    assert.deepEqual(await new Journal(join(root, 'home')).recent(), []);
  });
});

describe('doctor', () => {
  test('reports both products and both registrations when all is well', async () => {
    await claude.addSession({ pid: 4242 });
    await claude.addSession({ pid: 4243 });
    codex.threads = [{ id: makeId() }];

    const { code, lines, ran } = await cli(['doctor']);

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      'ok      2 Claude Code sessions running with an inbox.',
      'ok      The Codex daemon is running (CLI 9.9.9, daemon 9.9.8).',
      'ok      1 Codex session open.',
      'ok      Claude Code has the connector registered.',
      'ok      Codex has the connector registered.',
      'No problems found.',
    ]);
    // It only asks. It registers nothing.
    assert.deepEqual(ran, [
      { file: CLAUDE_BIN, args: ['mcp', 'get', 'switchboard'] },
      { file: CODEX_BIN, args: ['mcp', 'get', 'switchboard'] },
    ]);
  });

  test('treats nothing running and nothing registered as notes, not problems', async () => {
    await codex.setState({ status: 'stopped' });

    const { code, lines } = await cli(['doctor'], {
      answers: { [`${CLAUDE_BIN} mcp get`]: { code: 1 }, [`${CODEX_BIN} mcp get`]: { code: 1 } },
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, [
      `note    No Claude Code session with an inbox is running (looked in ${claude.sessionsDir}).`,
      'note    Codex is installed, and no Codex session is open: its daemon is not running.',
      'note    Claude Code does not have the connector registered. Run: switchboard install',
      'note    Codex does not have the connector registered. Run: switchboard install',
      'No problems found.',
    ]);
  });

  test('names a Claude Code version it cannot message as a problem', async () => {
    await claude.addSession({ pid: 4242 });
    await claude.addSession({ pid: 4243, peerProtocol: 2, file: { version: '3.0.0' } });
    await claude.addSession({ pid: 4244, peerProtocol: null, file: { version: '2.0.1' } });

    const { code, lines, text } = await cli(['doctor']);

    assert.equal(code, 1);
    assert.equal(lines[0], 'ok      3 Claude Code sessions running with an inbox.');
    assert.match(text, /problem 2 of them \(Claude Code 3\.0\.0, 2\.0\.1\) speak a message format this connector does not know\. Nothing is sent to those\./);
    assert.equal(lines.at(-1), '1 problem found.');
  });

  test('names a missing Codex and missing programs as problems', async () => {
    const { code, lines } = await cli(['doctor'], {
      ctx: {
        deps: { claude: claude.options, codex: { codexBin: join(root, 'no-such-codex') }, journal: new Journal(join(root, 'home')) },
        isExecutable: async () => false,
      },
    });

    assert.equal(code, 1);
    assert.match(lines[1] ?? '', /^problem Codex could not be started \(.*no-such-codex\)\. Is it installed and on the PATH\?$/);
    assert.equal(lines[2], 'problem The "claude" program is not on the PATH, so Claude Code cannot be checked.');
    assert.equal(lines[3], 'problem The "codex" program is not on the PATH, so Codex cannot be checked.');
    assert.equal(lines.at(-1), '3 problems found.');
  });

  test('names it as a problem when the Codex background service took the name of this connector', async () => {
    await codex.setState({ status: 'running', queueFails: 'Error: no such command' });

    const { code, lines } = await cli(['doctor']);

    assert.equal(code, 1);
    assert.ok(lines.includes(`problem ${DAEMON_TOOK_OUR_NAME}`));
    assert.equal(lines.at(-1), '1 problem found.');
  });

  test('notes it when Codex could not be seen to go first and no harm came of it', async () => {
    // A Codex window talked to the daemon before, as it does whenever a window starts the daemon.
    const thread = makeId();
    codex.threads = [{ id: thread }];
    await queueForCodex(thread, 'from a Codex window', codex.options);
    await codex.setState({ status: 'running', queueFails: 'Error: no such command' });

    const { code, text } = await cli(['doctor']);

    assert.equal(code, 0);
    assert.match(text, /note {4}It could not be confirmed that Codex introduced itself to its background service before this connector did/);
    assert.match(text, /No problems found\.$/);
  });

  test('names a daemon that does not answer as a problem', async () => {
    codex.silent = true;

    const { code, text } = await cli(['doctor'], {
      ctx: { deps: { claude: claude.options, codex: { ...codex.options, rpcTimeoutMs: 150 }, journal: new Journal(join(root, 'home')) } },
    });

    assert.equal(code, 1);
    assert.match(text, /ok {6}The Codex daemon is running/);
    assert.match(text, /problem The Codex daemon did not answer\. Is a Codex session open\?/);
  });
});

describe('install', () => {
  const claudeArgs = (): string[] => [
    'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'switchboard', '--',
    NODE_BIN, serverPath, '--host', 'claude', '--codex-bin', CODEX_BIN,
  ];
  const codexArgs = (): string[] => ['mcp', 'add', 'switchboard', '--', NODE_BIN, serverPath, '--host', 'codex'];

  test('registers the server with both products through their own commands', async () => {
    const { code, lines, ran } = await cli(['install']);

    assert.equal(code, 0);
    assert.deepEqual(ran, [
      { file: CLAUDE_BIN, args: claudeArgs() },
      { file: CODEX_BIN, args: codexArgs() },
    ]);
    assert.deepEqual(lines, [
      `Claude Code: ${[CLAUDE_BIN, ...claudeArgs()].join(' ')}`,
      '  registered with Claude Code.',
      `Codex: ${[CODEX_BIN, ...codexArgs()].join(' ')}`,
      '  registered with Codex.',
      'Done. Sessions that are already running get the tools after a restart.',
    ]);
  });

  test('tells each copy which product starts it, and gives Claude Code the full path of codex', async () => {
    const { ran } = await cli(['install']);
    const [forClaude, forCodex] = ran.map((item) => item.args.slice(item.args.indexOf('--') + 1));

    assert.deepEqual(forClaude, [NODE_BIN, serverPath, '--host', 'claude', '--codex-bin', CODEX_BIN]);
    assert.deepEqual(forCodex, [NODE_BIN, serverPath, '--host', 'codex']);
  });

  test('with --dry-run shows the two commands and runs nothing', async () => {
    const { code, lines, ran } = await cli(['install', '--dry-run']);

    assert.equal(code, 0);
    assert.deepEqual(ran, []);
    assert.deepEqual(lines, [
      'These two commands would be run. Nothing was changed.',
      `  ${[CLAUDE_BIN, ...claudeArgs()].join(' ')}`,
      `  ${[CODEX_BIN, ...codexArgs()].join(' ')}`,
    ]);
  });

  test('shows a path with a space or a quote the way a shell needs it, and passes it on as it is', async () => {
    const odd = join(root, "it's here.js");
    await writeFile(odd, '//\n');

    const dry = await cli(['install', '--dry-run'], { ctx: { serverPath: odd } });
    assert.ok(dry.lines[1]?.includes(` '${root}/it'\\''s here.js' --host claude`), dry.lines[1]);
    assert.ok(dry.lines[2]?.includes(` '${root}/it'\\''s here.js' --host codex`), dry.lines[2]);

    const real = await cli(['install'], { ctx: { serverPath: odd } });
    assert.ok(real.ran[0]?.args.includes(odd));
    assert.ok(real.ran[1]?.args.includes(odd));
  });

  test('says what failed, keeps going, and ends with a failure', async () => {
    const { code, lines, ran } = await cli(['install'], {
      answers: { [`${CLAUDE_BIN} mcp add`]: { code: 1, stderr: 'MCP server switchboard already exists in user config\n' } },
    });

    assert.equal(code, 1);
    assert.equal(ran.length, 2);
    assert.equal(lines[1], '  failed: MCP server switchboard already exists in user config');
    assert.equal(lines[3], '  registered with Codex.');
    assert.match(lines.at(-1) ?? '', /^Not everything was registered\./);
  });

  test('refuses before running anything when the server is not built', async () => {
    const missing = join(root, 'dist', 'server.js');
    const { code, lines, ran } = await cli(['install'], { ctx: { serverPath: missing } });

    assert.equal(code, 1);
    assert.deepEqual(ran, []);
    assert.deepEqual(lines, [`Error: ${missing} does not exist. Run "npm run build" in the switchboard folder first.`]);
  });

  test('refuses when one of the two products is not installed', async () => {
    const noClaude = await cli(['install'], { ctx: { isExecutable: async (path) => path === CODEX_BIN } });
    assert.equal(noClaude.code, 1);
    assert.deepEqual(noClaude.lines, ['Error: The "claude" program is not on the PATH. Is Claude Code installed?']);

    const noCodex = await cli(['install', '--dry-run'], { ctx: { isExecutable: async (path) => path === CLAUDE_BIN } });
    assert.equal(noCodex.code, 1);
    assert.deepEqual(noCodex.lines, ['Error: The "codex" program is not on the PATH. Is Codex installed?']);
    assert.deepEqual([...noClaude.ran, ...noCodex.ran], []);
  });
});

describe('uninstall', () => {
  test('removes both registrations through the products own commands', async () => {
    const { code, lines, ran } = await cli(['uninstall']);

    assert.equal(code, 0);
    assert.deepEqual(ran, [
      { file: CLAUDE_BIN, args: ['mcp', 'remove', '--scope', 'user', 'switchboard'] },
      { file: CODEX_BIN, args: ['mcp', 'remove', 'switchboard'] },
    ]);
    assert.deepEqual(lines, ['Removed from Claude Code.', 'Removed from Codex.']);
  });

  test('says so when there was nothing to remove', async () => {
    const { code, lines } = await cli(['uninstall'], {
      answers: { [`${CODEX_BIN} mcp remove`]: { code: 1, stderr: "No MCP server named 'switchboard' found.\n" } },
    });

    assert.equal(code, 0);
    assert.deepEqual(lines, ['Removed from Claude Code.', "Codex: nothing was removed (No MCP server named 'switchboard' found.)."]);
  });

  test('with --dry-run shows the two commands and runs nothing', async () => {
    const { lines, ran } = await cli(['uninstall', '--dry-run']);

    assert.deepEqual(ran, []);
    assert.deepEqual(lines, [
      'These two commands would be run. Nothing was changed.',
      `  ${CLAUDE_BIN} mcp remove --scope user switchboard`,
      `  ${CODEX_BIN} mcp remove switchboard`,
    ]);
  });

  test('works without the built server', async () => {
    const { code, ran } = await cli(['uninstall'], { ctx: { serverPath: join(root, 'nowhere', 'server.js') } });

    assert.equal(code, 0);
    assert.equal(ran.length, 2);
  });
});
