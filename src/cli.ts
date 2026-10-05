#!/usr/bin/env node
/**
 * The switchboard command for a person at a terminal.
 *
 *   node dist/cli.js list
 *   node dist/cli.js doctor
 *   node dist/cli.js install [--dry-run]
 *   node dist/cli.js uninstall [--dry-run]
 */

import { createRequire } from 'node:module';
import { runCli } from './commands.js';
import { Journal } from './journal.js';

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const code = await runCli(process.argv.slice(2), {
  deps: {
    journal: new Journal(),
    codex: { clientInfo: { name: 'switchboard', title: 'Switchboard', version: readVersion() } },
  },
  print: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
process.exit(code);
