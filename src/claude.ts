/**
 * The Claude Code side: which sessions are running, and how a message is
 * handed to one of them.
 *
 * Claude Code keeps one small file per running session in ~/.claude/sessions,
 * and gives each session an inbox: a Unix socket that only the same system
 * user can open. Other Claude Code sessions deliver messages there, one JSON
 * object per line, and so does this connector. The session then treats the
 * message the way it treats any message from another session: it tells its
 * model that the text is not from the user, applies its own inbound rules,
 * and may hold the message until the user approves it.
 *
 * The line format is Claude Code's own and is not part of its documentation.
 * Each session announces the version of it that it speaks as "peerProtocol".
 * Nothing is sent to a session that announces a version this file was not
 * written for.
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, isUuid } from './text.js';

/** The peer protocol version this connector knows how to speak. */
export const KNOWN_PEER_PROTOCOL = 1;

const MAX_REGISTRY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ClaudeSession {
  pid: number;
  sessionId: string;
  /** The name the session answers to. Claude Code picks one when the user has not. */
  name: string;
  cwd: string;
  /** "idle" or "busy", as the session last reported it. */
  status: string;
  /** "interactive" for a session in a terminal. */
  kind: string;
  version: string;
  peerProtocol: number | undefined;
  socketPath: string;
  updatedAt: number | undefined;
}

export interface ClaudeOptions {
  /** Where Claude Code keeps one file per running session. */
  sessionsDir?: string;
  isAlive?: (pid: number) => boolean;
  /** The system user whose sessions count. */
  uid?: number;
  timeoutMs?: number;
}

export function claudeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  return join(configDir !== undefined && configDir !== '' ? configDir : join(homedir(), '.claude'), 'sessions');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Also the answer for a process of another user, whose sessions are not ours to list.
    return false;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The running sessions that have an inbox. A file that cannot be read, that
 * belongs to a process that has ended, or whose socket is not a private socket
 * of this user is left out.
 */
export async function listClaudeSessions(options: ClaudeOptions = {}): Promise<ClaudeSession[]> {
  const dir = options.sessionsDir ?? claudeSessionsDir();
  const isAlive = options.isAlive ?? processIsAlive;
  const uid = options.uid ?? process.getuid?.();

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new BridgeError('unavailable', `The list of Claude Code sessions in ${dir} cannot be read.`);
  }

  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    const match = /^(\d{1,10})\.json$/.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);

    let data: Record<string, unknown>;
    try {
      const path = join(dir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_REGISTRY_BYTES || (uid !== undefined && info.uid !== uid)) continue;
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = data['sessionId'];
    const socketPath = data['messagingSocketPath'];
    if (data['pid'] !== pid || !isUuid(sessionId) || typeof socketPath !== 'string' || !socketPath.startsWith('/')) continue;
    if (!isAlive(pid)) continue;
    if (!(await isPrivateSocket(socketPath, uid))) continue;

    const protocol = data['peerProtocol'];
    const updatedAt = data['updatedAt'];
    sessions.push({
      pid,
      sessionId: sessionId.toLowerCase(),
      name: text(data['name']),
      cwd: text(data['cwd']),
      status: text(data['status']) || 'unknown',
      kind: text(data['kind']) || 'unknown',
      version: text(data['version']),
      peerProtocol: typeof protocol === 'number' ? protocol : undefined,
      socketPath,
      updatedAt: typeof updatedAt === 'number' ? updatedAt : undefined,
    });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
}

/**
 * One entry for each session. Two processes can be registered for the same
 * session: it was resumed in a second terminal, or the first process was left
 * suspended. The one that reported last is the one in use.
 */
export function withoutDuplicates(sessions: readonly ClaudeSession[]): ClaudeSession[] {
  const inUse = new Map<string, ClaudeSession>();
  for (const session of sessions) {
    const other = inUse.get(session.sessionId);
    const later = (session.updatedAt ?? 0) - (other?.updatedAt ?? 0);
    if (other === undefined || later > 0 || (later === 0 && session.pid > other.pid)) inUse.set(session.sessionId, session);
  }
  return sessions.filter((session) => inUse.get(session.sessionId) === session);
}

/** True for a socket that belongs to this user and that nobody else may open. */
async function isPrivateSocket(path: string, uid: number | undefined): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isSocket() && (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * Hands one message to a session's inbox.
 *
 * Resolving means the session's socket took the line. It does not mean the
 * model has read it: Claude Code may hold the message for the user's approval,
 * or drop it under that session's own rules, and reports neither back here.
 */
export async function deliverToClaude(
  session: ClaudeSession,
  message: { from: string; text: string },
  options: ClaudeOptions = {},
): Promise<void> {
  if (session.peerProtocol !== KNOWN_PEER_PROTOCOL) {
    throw new BridgeError(
      'unsupported',
      `That Claude Code session (version ${session.version || 'unknown'}) speaks peer protocol ` +
        `${session.peerProtocol ?? 'none'}, and this connector only knows protocol ${KNOWN_PEER_PROTOCOL}. ` +
        'Nothing was sent. The connector needs an update.',
    );
  }
  if (!(await isPrivateSocket(session.socketPath, options.uid ?? process.getuid?.()))) {
    throw new BridgeError('not_found', 'That Claude Code session is no longer running. Nothing was sent.');
  }

  const frame = {
    type: 'user',
    from: message.from,
    // The session drops a line addressed to another session id. This guards
    // against a process id that was reused by a new session since the listing.
    session_id: session.sessionId,
    message: { content: message.text },
  };
  await writeLine(session.socketPath, JSON.stringify(frame), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

function writeLine(socketPath: string, line: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket = connect({ path: socketPath });

    const finish = (err?: BridgeError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err === undefined) {
        resolve();
      } else {
        socket.destroy();
        reject(err);
      }
    };
    const timer = setTimeout(
      () => finish(new BridgeError('failed', 'The Claude Code session did not accept the message in time. Nothing was sent.')),
      timeoutMs,
    );

    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new BridgeError('not_found', 'That Claude Code session is no longer running. Nothing was sent.')
          : new BridgeError('failed', `The message could not be handed to the Claude Code session (${err.code ?? 'error'}). Nothing was sent.`),
      );
    });
    socket.once('connect', () => {
      // Done once the line has left this process. The session hangs up in its own time.
      socket.end(`${line}\n`, () => finish());
    });
    socket.once('close', () => {
      finish(new BridgeError('failed', 'The Claude Code session closed the connection before the message was written.'));
    });
  });
}
