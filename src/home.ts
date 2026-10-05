/**
 * Where this connector keeps the little it remembers: the journal of what was
 * passed on, and a note about the Codex daemon it last talked to.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function switchboardHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['SWITCHBOARD_HOME'];
  return override !== undefined && override !== '' ? override : join(homedir(), '.switchboard');
}
