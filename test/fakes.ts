/**
 * Stand-ins for the two products, built from real sockets and a real program,
 * so that the connector is tested through the same doors it uses in real life.
 *
 * FakeClaude is a folder of session files and one Unix socket per session.
 * FakeCodex is a WebSocket server on a Unix socket that answers like the
 * app-server daemon, and a small "codex" program that knows the two commands
 * the connector runs.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

export async function makeTempDir(): Promise<string> {
  // Short, because the path of a Unix socket may be at most about 100 bytes.
  return mkdtemp(join(tmpdir(), 'sb-'));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

let nextId = 1;
/** A session or thread id that looks like the real thing. */
export function makeId(): string {
  const tail = String(nextId++).padStart(12, '0');
  return `0198c2de-7a10-7b3c-9d4e-${tail}`;
}

export interface FakeSessionInput {
  pid: number;
  /** For a second process of a session that is already registered. */
  sessionId?: string;
  updatedAt?: number;
  name?: string;
  cwd?: string;
  status?: string;
  peerProtocol?: number | null;
  /** Mode of the socket file. A real inbox is 0600. */
  socketMode?: number;
  /** When true the socket never closes its side, like a peer that is slow to hang up. */
  lingers?: boolean;
  /** Overrides for the session file, to make it wrong in some way. */
  file?: Record<string, unknown>;
}

export interface FakeSession {
  pid: number;
  sessionId: string;
  socketPath: string;
  /** Every line the inbox received. */
  lines: string[];
}

export class FakeClaude {
  readonly sessionsDir: string;
  private readonly socketsDir: string;
  private readonly servers: Server[] = [];
  private readonly open = new Set<Socket>();
  alive = new Set<number>();

  constructor(private readonly root: string) {
    this.sessionsDir = join(root, 'sessions');
    this.socketsDir = join(root, 's');
  }

  /** What to pass as the options for the Claude Code side. */
  get options(): { sessionsDir: string; isAlive: (pid: number) => boolean; timeoutMs: number } {
    return { sessionsDir: this.sessionsDir, isAlive: (pid) => this.alive.has(pid), timeoutMs: 400 };
  }

  async addSession(input: FakeSessionInput): Promise<FakeSession> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.socketsDir, { recursive: true });
    const session: FakeSession = { pid: input.pid, sessionId: input.sessionId ?? makeId(), socketPath: join(this.socketsDir, `${input.pid}.sock`), lines: [] };

    const server = createServer({ allowHalfOpen: input.lingers === true }, (socket) => {
      this.open.add(socket);
      socket.on('close', () => this.open.delete(socket));
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let cut: number;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          session.lines.push(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(session.socketPath, resolve));
    await chmod(session.socketPath, input.socketMode ?? 0o600);
    this.servers.push(server);
    this.alive.add(input.pid);

    await this.writeFile(input.pid, {
      pid: input.pid,
      sessionId: session.sessionId,
      cwd: input.cwd ?? '/Users/alice/project',
      startedAt: 1790860893296,
      version: '2.1.286',
      ...(input.peerProtocol === null ? {} : { peerProtocol: input.peerProtocol ?? 1 }),
      kind: 'interactive',
      messagingSocketPath: session.socketPath,
      name: input.name ?? `session-${input.pid}`,
      status: input.status ?? 'idle',
      updatedAt: input.updatedAt ?? 1791174823620,
      ...input.file,
    });
    return session;
  }

  async writeFile(pid: number | string, content: unknown): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(join(this.sessionsDir, `${pid}.json`), typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await Promise.all(this.servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

export interface FakeThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd?: string;
  status?: Record<string, unknown>;
  updatedAt?: number;
  parentThreadId?: string | null;
  source?: unknown;
  /** A session that is not kept on disk. The daemon takes no queued messages for it. */
  ephemeral?: boolean;
  canAcceptDirectInput?: boolean | null;
}

interface Seen {
  /** The name the client gave when it introduced itself. */
  client: string;
  method: string;
  params: unknown;
}

/** Client names that do not change what the real daemon calls itself. */
const NOT_NAMING = new Set(['codex_app_server_daemon', 'codex-backend']);

/** What switchboard asks `codex queue` once for each start of the daemon. */
export const CHECK_TEXT = 'switchboard check, nothing to do';

export class FakeCodex {
  /** The fake "codex" program. */
  readonly bin: string;
  readonly socketPath: string;
  threads: FakeThread[] = [];
  /** Requests and notifications the daemon received, in order, from every client. */
  seen: Seen[] = [];
  /** The names of the clients that introduced themselves, in order. */
  inits: string[] = [];
  /** Answers to requests of the daemon that a client sent. There should be none. */
  answersFromClient: unknown[] = [];
  /** Paths clients connected to. */
  paths: string[] = [];
  /** When true the daemon accepts connections and never answers. */
  silent = false;
  /** Thread ids for which reading fails, as for a thread that just closed. */
  unreadable = new Set<string>();
  /** Like the real daemon: the first client to introduce itself names it, until it restarts. */
  private originator: string | undefined;
  private suffix: string | undefined;
  private queueCount = 0;
  private http: HttpServer | undefined;
  private wss: WebSocketServer | undefined;
  private readonly statePath: string;
  private readonly queuePath: string;
  private readonly callsPath: string;

  constructor(private readonly root: string) {
    this.bin = join(root, 'codex');
    this.socketPath = join(root, 'd.sock');
    this.statePath = join(root, 'codex-state.json');
    this.queuePath = join(root, 'queued.jsonl');
    this.callsPath = join(root, 'queue-calls.jsonl');
  }

  get options(): { codexBin: string; rpcTimeoutMs: number; stateDir: string; clientInfo: { name: string; title: string; version: string } } {
    return {
      codexBin: this.bin,
      rpcTimeoutMs: 600,
      stateDir: join(this.root, 'state'),
      clientInfo: { name: 'switchboard', title: 'Switchboard', version: '0.0.0-test' },
    };
  }

  /** The name the daemon signs its requests with, the way the real one reports it. */
  get userAgent(): string {
    return `${this.originator ?? 'codex_cli_rs'}/9.9.8 (Fake OS 1.0; arm64) fake-terminal${this.suffix === undefined ? '' : ` (${this.suffix})`}`;
  }

  /** Writes the program and starts the daemon, as a daemon that nobody has talked to yet. */
  async start(): Promise<void> {
    await this.setState({ status: 'running' });
    await writeFile(this.bin, PROGRAM, { mode: 0o755 });
    this.originator = undefined;
    this.suffix = undefined;

    this.http = createHttpServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (socket, request) => {
      this.paths.push(request.url ?? '');
      let client = '';
      // What a real daemon also does: tell every client about things it did not ask for.
      socket.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'x', status: { type: 'idle' } } }));
      socket.send(JSON.stringify({ id: 9001, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /' } }));

      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown; result?: unknown };
        if (message.method === undefined) {
          this.answersFromClient.push(message);
          return;
        }
        const params = (message.params ?? {}) as Record<string, unknown>;
        if (message.method === 'initialize') {
          const info = (params['clientInfo'] ?? {}) as { name?: unknown; version?: unknown };
          client = String(info.name ?? '');
          this.inits.push(client);
        }
        this.seen.push({ client, method: message.method, params: message.params });
        if (message.id === undefined || this.silent) return;

        const reply = (result: unknown): void => socket.send(JSON.stringify({ id: message.id, result }));
        const fail = (text: string, code = -32600): void => socket.send(JSON.stringify({ id: message.id, error: { code, message: text } }));

        if (message.method === 'initialize') {
          if (!NOT_NAMING.has(client)) {
            this.originator ??= client;
            const info = (params['clientInfo'] ?? {}) as { version?: unknown };
            this.suffix = `${client}; ${String(info.version ?? '')}`;
          }
          reply({ userAgent: this.userAgent, codexHome: this.root });
        } else if (message.method === 'thread/loaded/list') reply({ data: this.threads.map((thread) => thread.id), nextCursor: null });
        else if (message.method === 'thread/read') {
          const thread = this.threads.find((item) => item.id === params['threadId']);
          if (thread === undefined || this.unreadable.has(thread.id)) fail(`thread not found: ${String(params['threadId'])}`);
          else {
            reply({
              thread: {
                id: thread.id,
                name: thread.name ?? null,
                preview: thread.preview ?? '',
                cwd: thread.cwd ?? '/Users/alice/work',
                status: thread.status ?? { type: 'idle' },
                updatedAt: thread.updatedAt ?? 1791170000,
                createdAt: 1791100000,
                parentThreadId: thread.parentThreadId ?? null,
                source: thread.source ?? 'cli',
                ephemeral: thread.ephemeral ?? false,
                canAcceptDirectInput: thread.canAcceptDirectInput === undefined ? true : thread.canAcceptDirectInput,
                turns: [],
              },
            });
          }
        } else if (message.method === 'thread/queue/add') {
          const id = String(params['threadId']);
          const thread = this.threads.find((item) => item.id === id);
          if (thread === undefined) fail(`failed to read thread: invalid thread-store request: no rollout found for thread id ${id}`, -32603);
          else if (thread.ephemeral === true) fail(`ephemeral thread does not support queued submissions: ${id}`);
          else reply({ queuedSubmission: { id: `q-${++this.queueCount}`, input: params['input'], clientUserMessageId: params['clientUserMessageId'] } });
        } else fail(`Invalid request: unknown variant \`${message.method}\``);
      });
    });
    await new Promise<void>((resolve) => this.http?.listen(this.socketPath, resolve));
  }

  /** Changes what `codex app-server daemon version` and `codex queue` do. */
  async setState(state: { status?: string; raw?: string; queueFails?: string }): Promise<void> {
    await writeFile(
      this.statePath,
      JSON.stringify({ socketPath: this.socketPath, queuePath: this.queuePath, callsPath: this.callsPath, wsPath: WS_MODULE, ...state }),
    );
  }

  /** What `codex queue` handed over successfully, in order. */
  async queued(): Promise<Array<{ thread: string; message: string; argv: string[] }>> {
    return (await readLines(this.queuePath)) as Array<{ thread: string; message: string; argv: string[] }>;
  }

  /** Every time `codex queue` was run, whatever came of it. */
  async queueCalls(): Promise<Array<{ argv: string[] }>> {
    return (await readLines(this.callsPath)) as Array<{ argv: string[] }>;
  }

  /** How often switchboard asked `codex queue` to go first. */
  async checks(): Promise<number> {
    return (await this.queueCalls()).filter((call) => call.argv.includes(`--message=${CHECK_TEXT}`)).length;
  }

  async stop(): Promise<void> {
    for (const client of this.wss?.clients ?? []) client.terminate();
    await new Promise<void>((resolve) => (this.wss === undefined ? resolve() : this.wss.close(() => resolve())));
    await new Promise<void>((resolve) => (this.http === undefined ? resolve() : this.http.close(() => resolve())));
    this.http = undefined;
    this.wss = undefined;
  }

  /** Stops the daemon and starts a new one on the same path, as `codex app-server daemon restart` does. */
  async restart(): Promise<void> {
    await this.stop();
    await rm(this.socketPath, { force: true });
    await this.start();
  }
}

async function readLines(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** The ws package, for the fake program, which runs outside this project. */
const WS_MODULE = createRequire(import.meta.url).resolve('ws');

/**
 * The fake program. It reads its orders from codex-state.json next to itself.
 * Like the real one, `codex queue` is a client of the daemon: it connects,
 * introduces itself as Codex's own client, and asks the daemon to queue.
 */
const PROGRAM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'codex-state.json'), 'utf8'));
const args = process.argv.slice(2);

if (args.join(' ') === 'app-server daemon version') {
  if (state.raw !== undefined) process.stdout.write(state.raw);
  else process.stdout.write(JSON.stringify({ status: state.status, backend: 'pid', socketPath: state.socketPath, cliVersion: '9.9.9', appServerVersion: '9.9.8' }));
  process.exit(0);
} else if (args[0] === 'queue') {
  fs.appendFileSync(state.callsPath, JSON.stringify({ argv: args }) + '\\n');
  const fail = (text) => {
    process.stderr.write('Error: ' + text + '\\n');
    process.exit(1);
  };
  if (state.queueFails !== undefined) {
    process.stderr.write(state.queueFails + '\\n');
    process.exit(1);
  }
  const thread = args[args.indexOf('--thread') + 1];
  const message = (args.find((arg) => arg.startsWith('--message=')) || '').slice('--message='.length);
  const { WebSocket } = require(state.wsPath);
  const socket = new WebSocket('ws+unix:' + state.socketPath + ':/rpc');
  const timer = setTimeout(() => fail('timed out waiting for the app server'), 400);
  socket.on('error', () => fail('failed to connect to the app server'));
  socket.on('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui', title: null, version: '9.9.9' }, capabilities: { experimentalApi: true } } }));
  });
  socket.on('message', (raw) => {
    const answer = JSON.parse(String(raw));
    if (answer.method !== undefined) return;
    if (answer.id === 1) {
      socket.send(JSON.stringify({ method: 'initialized' }));
      socket.send(JSON.stringify({ id: 2, method: 'thread/queue/add', params: { threadId: thread, input: [{ type: 'text', text: message, text_elements: [] }], clientUserMessageId: 'm-1' } }));
    } else if (answer.id === 2) {
      clearTimeout(timer);
      if (answer.error) fail('failed to queue session message: thread/queue/add failed: ' + answer.error.message + ' (code ' + answer.error.code + ')');
      fs.appendFileSync(state.queuePath, JSON.stringify({ thread, message, argv: args }) + '\\n');
      process.stdout.write('Queued message ' + answer.result.queuedSubmission.id + ' for thread ' + thread + '.\\n');
      process.exit(0);
    }
  });
} else {
  process.stderr.write('fake codex: unexpected arguments: ' + args.join(' ') + '\\n');
  process.exit(64);
}
`;
