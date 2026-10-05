/**
 * The commands behind the switchboard CLI: list, doctor, install, uninstall.
 *
 * Installing registers the MCP server with both products through their own
 * commands, `claude mcp add` and `codex mcp add`. Nothing is written to a
 * configuration file from here.
 */

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_TOOK_OUR_NAME, PRODUCT, surveySessions, type Agent, type Deps, type Peer } from './bridge.js';
import { claudeSessionsDir, KNOWN_PEER_PROTOCOL, listClaudeSessions, withoutDuplicates } from './claude.js';
import { codexDaemon, surveyCodex, type CommandResult, type RunCommand } from './codex.js';
import { BridgeError, oneLine } from './text.js';

export const USAGE = `Usage:
  switchboard list                  Show the Claude Code and Codex sessions that are running.
  switchboard doctor                Check that both products can be reached, and say what is wrong if not.
  switchboard install [--dry-run]   Register the connector with Claude Code and with Codex.
  switchboard uninstall [--dry-run] Remove both registrations.

Sessions that were already running keep their old tools until they are restarted.`;

export interface CommandDeps {
  deps: Deps;
  print(line: string): void;
  run?: RunCommand;
  /** Where "claude" and "codex" are looked for. */
  pathEnv?: string;
  /** The program that runs the server: this Node. */
  nodeBin?: string;
  /** The built server.js. */
  serverPath?: string;
  isExecutable?: (path: string) => Promise<boolean>;
}

const runProgram: RunCommand = (file, args) =>
  new Promise<CommandResult>((resolve) => {
    execFile(file, [...args], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      if (failed !== null && typeof failed.code === 'string') resolve({ code: null, stdout: '', stderr: '', startError: failed.code });
      else resolve({ code: failed === null ? 0 : typeof failed.code === 'number' ? failed.code : 1, stdout, stderr });
    });
  });

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The full path of a program, the way a shell would find it. */
async function findProgram(name: string, ctx: CommandDeps): Promise<string | undefined> {
  const check = ctx.isExecutable ?? executable;
  for (const dir of (ctx.pathEnv ?? process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (await check(candidate)) return candidate;
  }
  return undefined;
}

export async function runCli(argv: readonly string[], ctx: CommandDeps): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest);
  const known = new Set(['--dry-run']);
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    ctx.print(USAGE);
    return command === undefined ? 2 : 0;
  }
  if ([...flags].some((flag) => !known.has(flag)) || (flags.size > 0 && command !== 'install' && command !== 'uninstall')) {
    ctx.print(`Unknown option for "${oneLine(command, 40)}".\n\n${USAGE}`);
    return 2;
  }

  try {
    switch (command) {
      case 'list':
        return await list(ctx);
      case 'doctor':
        return await doctor(ctx);
      case 'install':
        return await install(ctx, flags.has('--dry-run'));
      case 'uninstall':
        return await uninstall(ctx, flags.has('--dry-run'));
      default:
        ctx.print(`Unknown command "${oneLine(command, 40)}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    ctx.print(`Error: ${err instanceof BridgeError ? err.message : 'something went wrong.'}`);
    return 1;
  }
}

function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  return rows.map((row) =>
    `  ${row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0))).join('  ')}`.trimEnd(),
  );
}

function describeSessions(agent: Agent, peers: Peer[]): string[] {
  if (peers.length === 0) return [`${PRODUCT[agent]}: no session is running.`];
  const rows = peers.map((peer) => [
    peer.address,
    peer.name ?? (peer.about === undefined ? '(no name)' : `(${peer.about})`),
    peer.unreachable === undefined ? peer.status : 'cannot be messaged',
    peer.cwd,
  ]);
  return [`${PRODUCT[agent]} sessions`, ...table([['ADDRESS', 'NAME', 'STATUS', 'DIRECTORY'], ...rows])];
}

async function list(ctx: CommandDeps): Promise<number> {
  for (const agent of ['claude', 'codex'] as const) {
    try {
      const survey = await surveySessions(agent, ctx.deps);
      for (const line of describeSessions(agent, survey.peers)) ctx.print(line);
      if (survey.warning !== undefined) ctx.print(`Warning: ${survey.warning}`);
    } catch (err) {
      ctx.print(`${PRODUCT[agent]}: ${err instanceof BridgeError ? err.message : 'could not be asked.'}`);
    }
    if (agent === 'claude') ctx.print('');
  }
  return 0;
}

async function doctor(ctx: CommandDeps): Promise<number> {
  let problems = 0;
  const ok = (line: string): void => ctx.print(`ok      ${line}`);
  const bad = (line: string): void => {
    problems += 1;
    ctx.print(`problem ${line}`);
  };
  const note = (line: string): void => ctx.print(`note    ${line}`);

  // Claude Code
  const dir = ctx.deps.claude?.sessionsDir ?? claudeSessionsDir();
  try {
    const sessions = withoutDuplicates(await listClaudeSessions(ctx.deps.claude));
    if (sessions.length === 0) note(`No Claude Code session with an inbox is running (looked in ${dir}).`);
    else ok(`${sessions.length} Claude Code session${sessions.length === 1 ? '' : 's'} running with an inbox.`);
    const unknown = sessions.filter((session) => session.peerProtocol !== KNOWN_PEER_PROTOCOL);
    if (unknown.length > 0) {
      bad(
        `${unknown.length} of them (Claude Code ${[...new Set(unknown.map((session) => session.version || 'unknown'))].join(', ')}) ` +
          `speak a message format this connector does not know. Nothing is sent to those. The connector needs an update.`,
      );
    }
  } catch (err) {
    bad(err instanceof BridgeError ? err.message : 'The Claude Code sessions could not be read.');
  }

  // Codex
  try {
    const daemon = await codexDaemon(ctx.deps.codex);
    if (!daemon.running) note('Codex is installed, and no Codex session is open: its daemon is not running.');
    else {
      ok(`The Codex daemon is running (CLI ${daemon.cliVersion ?? '?'}, daemon ${daemon.daemonVersion ?? '?'}).`);
      const survey = await surveyCodex(ctx.deps.codex);
      ok(`${survey.sessions.length} Codex session${survey.sessions.length === 1 ? '' : 's'} open.`);
      if (survey.tookOurName) bad(DAEMON_TOOK_OUR_NAME);
      else if (!survey.codexWentFirst) {
        note(
          'It could not be confirmed that Codex introduced itself to its background service before this connector did: ' +
            '"codex queue" gave an answer this connector does not know. No harm was found.',
        );
      }
    }
  } catch (err) {
    bad(err instanceof BridgeError ? err.message : 'Codex could not be asked.');
  }

  // Registration
  const run = ctx.run ?? runProgram;
  for (const [product, program, args] of [
    ['Claude Code', 'claude', ['mcp', 'get', 'switchboard']],
    ['Codex', 'codex', ['mcp', 'get', 'switchboard']],
  ] as const) {
    const bin = await findProgram(program, ctx);
    if (bin === undefined) {
      bad(`The "${program}" program is not on the PATH, so ${product} cannot be checked.`);
      continue;
    }
    const result = await run(bin, args);
    if (result.code === 0) ok(`${product} has the connector registered.`);
    else note(`${product} does not have the connector registered. Run: switchboard install`);
  }

  ctx.print(problems === 0 ? 'No problems found.' : `${problems} problem${problems === 1 ? '' : 's'} found.`);
  return problems === 0 ? 0 : 1;
}

function shown(file: string, args: readonly string[]): string {
  const quote = (value: string): string => (/^[A-Za-z0-9_.:/@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
  return [file, ...args].map(quote).join(' ');
}

interface Step {
  product: string;
  file: string;
  args: string[];
}

async function steps(ctx: CommandDeps, action: 'install' | 'uninstall'): Promise<Step[]> {
  const claude = await findProgram('claude', ctx);
  const codex = await findProgram('codex', ctx);
  if (claude === undefined) throw new BridgeError('unavailable', 'The "claude" program is not on the PATH. Is Claude Code installed?');
  if (codex === undefined) throw new BridgeError('unavailable', 'The "codex" program is not on the PATH. Is Codex installed?');

  if (action === 'uninstall') {
    return [
      { product: 'Claude Code', file: claude, args: ['mcp', 'remove', '--scope', 'user', 'switchboard'] },
      { product: 'Codex', file: codex, args: ['mcp', 'remove', 'switchboard'] },
    ];
  }

  const node = ctx.nodeBin ?? process.execPath;
  const server = ctx.serverPath ?? join(dirname(fileURLToPath(import.meta.url)), 'server.js');
  if (!(await readable(server))) {
    throw new BridgeError('unavailable', `${server} does not exist. Run "npm run build" in the switchboard folder first.`);
  }
  return [
    {
      product: 'Claude Code',
      file: claude,
      // The full path of codex goes along, because a session does not always inherit the PATH of a terminal.
      args: ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'switchboard', '--', node, server, '--host', 'claude', '--codex-bin', codex],
    },
    { product: 'Codex', file: codex, args: ['mcp', 'add', 'switchboard', '--', node, server, '--host', 'codex'] },
  ];
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function install(ctx: CommandDeps, dryRun: boolean): Promise<number> {
  const plan = await steps(ctx, 'install');
  if (dryRun) {
    ctx.print('These two commands would be run. Nothing was changed.');
    for (const step of plan) ctx.print(`  ${shown(step.file, step.args)}`);
    return 0;
  }

  const run = ctx.run ?? runProgram;
  let failed = 0;
  for (const step of plan) {
    ctx.print(`${step.product}: ${shown(step.file, step.args)}`);
    const result = await run(step.file, step.args);
    if (result.code === 0) ctx.print(`  registered with ${step.product}.`);
    else {
      failed += 1;
      ctx.print(`  failed: ${oneLine(result.stderr || result.stdout || result.startError || 'no reason given', 300)}`);
    }
  }
  ctx.print(
    failed === 0
      ? 'Done. Sessions that are already running get the tools after a restart.'
      : 'Not everything was registered. Fix what failed and run the command again, or run "switchboard uninstall" to undo the rest.',
  );
  return failed === 0 ? 0 : 1;
}

async function uninstall(ctx: CommandDeps, dryRun: boolean): Promise<number> {
  const plan = await steps(ctx, 'uninstall');
  if (dryRun) {
    ctx.print('These two commands would be run. Nothing was changed.');
    for (const step of plan) ctx.print(`  ${shown(step.file, step.args)}`);
    return 0;
  }
  const run = ctx.run ?? runProgram;
  for (const step of plan) {
    const result = await run(step.file, step.args);
    ctx.print(
      result.code === 0
        ? `Removed from ${step.product}.`
        : `${step.product}: nothing was removed (${oneLine(result.stderr || result.stdout || 'not registered', 200)}).`,
    );
  }
  return 0;
}
