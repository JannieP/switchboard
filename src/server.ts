#!/usr/bin/env node
/**
 * Starts the switchboard MCP server on stdio.
 *
 *   node dist/server.js --host claude [--codex-bin /path/to/codex]
 *   node dist/server.js --host codex
 *
 * "--host" says which product is starting this copy.
 */

import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Agent } from './bridge.js';
import { Journal } from './journal.js';
import { createBridgeServer } from './mcp.js';

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readArgs(argv: readonly string[]): { host: Agent; codexBin: string | undefined } {
  let host: string | undefined;
  let codexBin: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = (argv[index] ?? '').split('=', 2);
    const value = (): string | undefined => inline ?? argv[++index];
    if (flag === '--host') host = value();
    else if (flag === '--codex-bin') codexBin = value();
  }
  if (host !== 'claude' && host !== 'codex') {
    process.stderr.write('switchboard: start the server with --host claude or --host codex, to say which product is starting it.\n');
    process.exit(2);
  }
  return { host, codexBin: codexBin === undefined || codexBin === '' ? undefined : codexBin };
}

async function main(): Promise<void> {
  const { host, codexBin } = readArgs(process.argv.slice(2));
  const version = readVersion();
  const server = createBridgeServer({
    host,
    version,
    deps: {
      journal: new Journal(),
      codex: {
        clientInfo: { name: 'switchboard', title: 'Switchboard', version },
        ...(codexBin === undefined ? {} : { codexBin }),
      },
    },
  });

  // The product that started this copy closes stdin when it is done with it.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`switchboard: could not start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
