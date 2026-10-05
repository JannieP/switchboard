/**
 * The Codex side: which sessions are open, and how a message is handed to one
 * of them.
 *
 * Open Codex sessions live in one shared background process, the app-server
 * daemon. Three things are asked of Codex here, all through its own means:
 *
 * - `codex app-server daemon version` says whether the daemon runs and where
 *   its control socket is.
 * - The daemon's JSON-RPC interface, the one Codex's own windows use, lists
 *   the sessions that are open. This connector introduces itself by its own
 *   name, asks, and disconnects. It never starts, resumes or answers anything.
 * - `codex queue` hands a message to a session. Codex starts a turn with it
 *   when the session is idle, the same as for a message its user queues.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { switchboardHome } from './home.js';
import { BridgeError, isUuid, oneLine } from './text.js';

const COMMAND_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 8_000;
const MAX_THREADS = 60;
const DAEMON_NOTE = 'codex-daemon.json';
const CHECK_TEXT = 'switchboard check, nothing to do';

export interface CodexSession {
  /** The thread id. Codex calls a session a thread. */
  id: string;
  name: string | null;
  /** The start of the first thing the user asked in it. Empty when unknown. */
  preview: string;
  cwd: string;
  /** "idle", "active" or "systemError". */
  status: string;
  updatedAt: number | undefined;
}

export interface CodexSurvey {
  sessions: CodexSession[];
  /**
   * True when the daemon signs what it sends to OpenAI with this connector's
   * name instead of Codex's own. letCodexGoFirst exists to keep this false.
   */
  tookOurName: boolean;
  /** False when it could not be confirmed that Codex's own client introduced itself first. */
  codexWentFirst: boolean;
}

export interface CodexDaemon {
  running: boolean;
  socketPath: string | undefined;
  cliVersion: string | undefined;
  daemonVersion: string | undefined;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all. */
  startError?: string;
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface CodexOptions {
  /** The codex program. Found on the PATH when not given. */
  codexBin?: string;
  run?: RunCommand;
  /** Name and version this connector gives the daemon. */
  clientInfo?: { name: string; title: string; version: string };
  rpcTimeoutMs?: number;
  /** Where this connector keeps its note about the daemon. */
  stateDir?: string;
}

const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (failed !== null && typeof failed.code === 'string') {
          resolve({ code: null, stdout: '', stderr: '', startError: failed.code });
          return;
        }
        resolve({ code: failed === null ? 0 : typeof failed.code === 'number' ? failed.code : 1, stdout, stderr });
      },
    );
  });

function codexMissing(bin: string): BridgeError {
  return new BridgeError('unavailable', `Codex could not be started (${bin}). Is it installed and on the PATH?`);
}

/** Asks Codex whether its daemon runs. Does not start it. */
export async function codexDaemon(options: CodexOptions = {}): Promise<CodexDaemon> {
  const bin = options.codexBin ?? 'codex';
  const result = await (options.run ?? runCommand)(bin, ['app-server', 'daemon', 'version']);
  if (result.startError !== undefined) throw codexMissing(bin);

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // An answer that is not JSON means no daemon this connector can talk to.
  }
  const socketPath = data['socketPath'];
  return {
    running: data['status'] === 'running' && typeof socketPath === 'string' && socketPath.startsWith('/'),
    socketPath: typeof socketPath === 'string' ? socketPath : undefined,
    cliVersion: typeof data['cliVersion'] === 'string' ? data['cliVersion'] : undefined,
    daemonVersion: typeof data['appServerVersion'] === 'string' ? data['appServerVersion'] : undefined,
  };
}

/** The sessions that are open in the daemon now. */
export async function listCodexSessions(options: CodexOptions = {}): Promise<CodexSession[]> {
  return (await surveyCodex(options)).sessions;
}

/**
 * The sessions that are open in the daemon now, and what talking to the daemon
 * did to it. Threads that Codex started for its own use are left out.
 */
export async function surveyCodex(options: CodexOptions = {}): Promise<CodexSurvey> {
  const daemon = await codexDaemon(options);
  if (!daemon.running || daemon.socketPath === undefined) return { sessions: [], tookOurName: false, codexWentFirst: true };

  const codexWentFirst = await letCodexGoFirst(daemon.socketPath, options);
  const { rpc, userAgent } = await connectDaemon(daemon.socketPath, options);
  try {
    const loaded = record(await rpc.request('thread/loaded/list', {}));
    const ids = (Array.isArray(loaded['data']) ? loaded['data'] : []).filter(isUuid).slice(0, MAX_THREADS);

    const sessions: CodexSession[] = [];
    for (const id of ids) {
      let thread: Record<string, unknown>;
      try {
        thread = record(record(await rpc.request('thread/read', { threadId: id, includeTurns: false }))['thread']);
      } catch (err) {
        if (err instanceof BridgeError && err.kind === 'failed') continue; // gone between the two requests
        throw err;
      }
      if (typeof thread['parentThreadId'] === 'string' || isHelper(thread['source']) || thread['canAcceptDirectInput'] === false) continue;
      // Not kept on disk: the short-lived threads Codex makes for its own use, such as the one that
      // thinks up a title for a new session. Codex takes no queued messages for these.
      if (thread['ephemeral'] === true) continue;

      const name = thread['name'];
      const updatedAt = thread['updatedAt'];
      sessions.push({
        id: id.toLowerCase(),
        name: typeof name === 'string' && name.trim() !== '' ? oneLine(name, 120) : null,
        preview: typeof thread['preview'] === 'string' ? oneLine(thread['preview'], 80) : '',
        cwd: typeof thread['cwd'] === 'string' ? thread['cwd'] : '',
        status: typeof record(thread['status'])['type'] === 'string' ? String(record(thread['status'])['type']) : 'unknown',
        updatedAt: typeof updatedAt === 'number' ? updatedAt * 1000 : undefined,
      });
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    // The daemon's user agent starts with the name it signs its requests with.
    const ownName = (options.clientInfo ?? DEFAULT_CLIENT).name;
    return { sessions, tookOurName: userAgent.startsWith(`${ownName}/`), codexWentFirst };
  } finally {
    rpc.close();
  }
}

/** A session Codex spawned for another session: a sub-agent, a review, a compaction. */
function isHelper(source: unknown): boolean {
  if (typeof source === 'string') return source.toLowerCase().startsWith('subagent');
  return source !== null && typeof source === 'object' && Object.keys(source).some((key) => key.toLowerCase().startsWith('subagent'));
}

/**
 * Makes sure Codex's own client has introduced itself to this daemon before
 * this connector does. Returns whether that could be confirmed.
 *
 * The daemon signs everything it sends to OpenAI with the name of the first
 * client that introduces itself, for as long as it runs. That has to be
 * Codex's own client. Normally it is, because a Codex window starts the daemon.
 * But a daemon can also be started on its own, and then this connector could
 * be the first, and every Codex session of the user would go out under the
 * connector's name.
 *
 * `codex queue` is a client of Codex's own. Asked to queue for a session id
 * that cannot exist, it connects, introduces itself, is told that there is no
 * such session, and stops. Nothing is queued. This is done once for each start
 * of the daemon, and remembered in a small file.
 */
async function letCodexGoFirst(socketPath: string, options: CodexOptions): Promise<boolean> {
  const instance = await daemonInstance(socketPath);
  const dir = options.stateDir ?? switchboardHome();
  const file = join(dir, DAEMON_NOTE);
  if (instance !== undefined && (await readNote(file)) === instance) return true;

  const bin = options.codexBin ?? 'codex';
  const result = await (options.run ?? runCommand)(bin, ['queue', '--thread', randomUUID(), `--message=${CHECK_TEXT}`]);
  if (result.startError !== undefined) throw codexMissing(bin);
  // An answer about the request itself means Codex's client reached the daemon, and so introduced itself.
  const reached = result.code === 0 || /thread\/queue\/add/.test(result.stderr);
  if (reached && instance !== undefined) await writeNote(dir, file, instance).catch(() => undefined);
  return reached;
}

/** Names one start of the daemon: its socket is made anew each time it starts. */
async function daemonInstance(socketPath: string): Promise<string | undefined> {
  try {
    const [link, socket] = await Promise.all([lstat(socketPath), stat(socketPath)]);
    return [socketPath, Math.round(link.birthtimeMs || link.ctimeMs), socket.ino].join('|');
  } catch {
    return undefined;
  }
}

async function readNote(file: string): Promise<string | undefined> {
  try {
    const data = record(JSON.parse(await readFile(file, 'utf8')));
    return typeof data['daemon'] === 'string' ? data['daemon'] : undefined;
  } catch {
    return undefined;
  }
}

async function writeNote(dir: string, file: string, instance: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ daemon: instance, codexIntroducedItself: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/**
 * Hands a message to an open session through `codex queue`. Codex starts a
 * turn with it at once when the session is idle, and after the running turn
 * otherwise. Returns the id Codex gave the queued message.
 */
export async function queueForCodex(threadId: string, text: string, options: CodexOptions = {}): Promise<string> {
  if (!isUuid(threadId)) throw new BridgeError('invalid_input', 'That is not a Codex session id.');
  const bin = options.codexBin ?? 'codex';
  // "--message=" keeps a text that starts with a dash from being read as an option.
  const result = await (options.run ?? runCommand)(bin, ['queue', '--thread', threadId, `--message=${text}`]);
  if (result.startError !== undefined) throw codexMissing(bin);
  if (result.code !== 0) {
    const line = result.stderr.split('\n').find((item) => item.trim() !== '') ?? '';
    if (/no rollout found|thread not found/i.test(line)) {
      throw new BridgeError('not_found', 'That Codex session is no longer there. Nothing was sent.');
    }
    // Codex says: "Error: failed to queue session message: thread/queue/add failed: <the reason> (code -32600)".
    const reason = oneLine(line.replace(/^\s*Error:\s*/i, '').replace(/^failed to queue session message:\s*/i, '').replace(/^thread\/queue\/add failed:\s*/i, ''), 200);
    throw new BridgeError('failed', `Codex did not take the message${reason === '' ? '' : `: ${reason.replace(/[.\s]+$/, '')}`}. Nothing was sent.`);
  }
  return /Queued message (\S+) for thread/.exec(result.stdout)?.[1] ?? '';
}

interface Rpc {
  request(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

const DEFAULT_CLIENT = { name: 'switchboard', title: 'Switchboard', version: '0.0.0' };

/**
 * Opens a short conversation with the daemon over its control socket: a
 * WebSocket on a Unix socket, carrying JSON-RPC without the "jsonrpc" field.
 * Also returns the user agent the daemon answers with.
 */
function connectDaemon(socketPath: string, options: CodexOptions): Promise<{ rpc: Rpc; userAgent: string }> {
  const timeoutMs = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT;
  const unreachable = (): BridgeError => new BridgeError('unavailable', 'The Codex daemon did not answer. Is a Codex session open?');

  return new Promise<{ rpc: Rpc; userAgent: string }>((resolve, reject) => {
    // Never "/daemon/shutdown": that path stops the daemon.
    const socket = new WebSocket(`ws+unix:${socketPath}:/rpc`, { handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024 });
    const waiting = new Map<number, { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
    let nextId = 1;
    let opened = false;

    const failAll = (err: Error): void => {
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      waiting.clear();
    };

    const rpc: Rpc = {
      request(method, params) {
        return new Promise<unknown>((done, fail) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            waiting.delete(id);
            fail(unreachable());
          }, timeoutMs);
          waiting.set(id, { resolve: done, reject: fail, timer });
          socket.send(JSON.stringify({ id, method, params }), (err) => {
            if (err === undefined || err === null) return;
            clearTimeout(timer);
            waiting.delete(id);
            fail(unreachable());
          });
        });
      },
      close() {
        failAll(unreachable());
        socket.terminate();
      },
    };

    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try {
        message = record(JSON.parse(String(raw)));
      } catch {
        return;
      }
      // Only answers to our own requests matter. Notifications are ignored, and so
      // are requests from the daemon: approvals belong to the windows of Codex itself.
      if (typeof message['id'] !== 'number' || typeof message['method'] === 'string') return;
      const entry = waiting.get(message['id']);
      if (entry === undefined) return;
      waiting.delete(message['id']);
      clearTimeout(entry.timer);
      if (message['error'] !== undefined && message['error'] !== null) {
        entry.reject(new BridgeError('failed', `Codex answered with an error: ${oneLine(String(record(message['error'])['message'] ?? ''), 200)}`));
      } else {
        entry.resolve(message['result']);
      }
    });
    socket.once('open', () => {
      opened = true;
      rpc
        .request('initialize', { clientInfo, capabilities: {} })
        .then((answer) => {
          socket.send(JSON.stringify({ method: 'initialized' }));
          const userAgent = record(answer)['userAgent'];
          resolve({ rpc, userAgent: typeof userAgent === 'string' ? userAgent : '' });
        })
        .catch((err: unknown) => {
          socket.terminate();
          reject(err instanceof BridgeError && err.kind === 'failed' ? err : unreachable());
        });
    });
    socket.once('error', () => {
      failAll(unreachable());
      if (!opened) reject(unreachable());
    });
    socket.once('close', () => failAll(unreachable()));
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
