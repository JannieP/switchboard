/**
 * A record of what was passed on, and the limits that stop two agents from
 * answering each other without end.
 *
 * One line per attempt: when, from, to, how long the text was, and whether it
 * went through. The text itself is never written. A short hash of it is kept
 * so that a message repeated word for word can be recognised.
 */

import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { switchboardHome } from './home.js';
import { BridgeError } from './text.js';

/** Messages one session may send to one other session. */
export const MAX_PER_MINUTE = 6;
export const MAX_PER_HOUR = 60;
/** The same text to the same session within this time is a repeat. */
export const REPEAT_WINDOW_MS = 2 * 60 * 1000;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;

export interface JournalEntry {
  ts: string;
  from: string;
  to: string;
  chars: number;
  /** First 16 hex characters of the SHA-256 of the text. */
  hash: string;
  ok: boolean;
  error?: string;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export class Journal {
  private readonly path: string;

  constructor(
    private readonly dir: string = switchboardHome(),
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dir, 'journal.jsonl');
  }

  /**
   * Refuses a message that would exceed the limits. Called before anything is
   * sent, with the hash of the text that is about to go out.
   */
  async check(from: string, to: string, hash: string): Promise<void> {
    const now = this.now();
    const sent = (await this.recent()).filter((entry) => entry.ok && entry.from === from && entry.to === to);
    const age = (entry: JournalEntry): number => now - Date.parse(entry.ts);

    if (sent.some((entry) => entry.hash === hash && age(entry) < REPEAT_WINDOW_MS)) {
      throw new BridgeError('rate_limited', 'This exact message was sent to that session a moment ago. It was not sent again.');
    }
    if (sent.filter((entry) => age(entry) < MINUTE).length >= MAX_PER_MINUTE) {
      throw new BridgeError(
        'rate_limited',
        `${MAX_PER_MINUTE} messages went to that session in the last minute, which is the limit. ` +
          'Wait a minute, put what is left into one message, or stop if no answer is needed.',
      );
    }
    if (sent.filter((entry) => age(entry) < HOUR).length >= MAX_PER_HOUR) {
      throw new BridgeError(
        'rate_limited',
        `${MAX_PER_HOUR} messages went to that session in the last hour, which is the limit. Tell your user instead of sending more.`,
      );
    }
  }

  async record(entry: Omit<JournalEntry, 'ts'>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    try {
      if ((await stat(this.path)).size > MAX_JOURNAL_BYTES) await rename(this.path, join(this.dir, 'journal.1.jsonl'));
    } catch {
      // No journal yet.
    }
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry });
    await appendFile(this.path, `${line}\n`, { mode: 0o600 });
  }

  /** The entries of the last hour or so, read from the end of the file. */
  async recent(): Promise<JournalEntry[]> {
    let text: string;
    try {
      const handle = await open(this.path, 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        text = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Partial<JournalEntry> | null;
        if (
          parsed !== null &&
          typeof parsed.ts === 'string' &&
          typeof parsed.from === 'string' &&
          typeof parsed.to === 'string' &&
          typeof parsed.hash === 'string' &&
          typeof parsed.ok === 'boolean'
        ) {
          entries.push(parsed as JournalEntry);
        }
      } catch {
        // The first line of a tail may be cut in half.
      }
    }
    return entries;
  }
}
