/**
 * Lightweight utility to output dev server config values (port, db path)
 * so that shell scripts can source them.
 *
 * Usage:
 *   bun run dev:get:port        → prints the port number
 *   bun run dev:get:db_path     → prints the database URL/path
 */

import { join, basename } from 'path';
import { tmpdir } from 'os';
import { deriveDevPort } from './dev-port-allocator';
import { isPaseoScriptAvailable, getPaseoScriptStatus } from './lib/paseo';

const dirName = basename(process.cwd());

// --- Port (check Paseo status first, fallback to deriveDevPort) ---
function getPort(target = 'dev:full'): string {
  if (process.env.PORT) return process.env.PORT;

  if (isPaseoScriptAvailable(target)) {
    const status = getPaseoScriptStatus(target) ?? getPaseoScriptStatus('dev');
    if (status?.port) {
      return String(status.port);
    }
  }

  return deriveDevPort(process.cwd(), target);
}

// --- DB path (same logic as dev.ts) ---
function getDbPath(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PLEXUS_POSTGRES_DRIVER === 'pglite') {
    const dataDir =
      process.env.PLEXUS_PGLITE_DATA_DIR ?? join(tmpdir(), `plexus-${dirName}.pglite`);
    return dataDir;
  }
  return `sqlite://${join(tmpdir(), `plexus-${dirName}.db`)}`;
}

// --- CLI ---
const command = process.argv[2];
if (command === 'port') {
  console.log(getPort());
} else if (command === 'db_path') {
  console.log(getDbPath());
} else {
  console.error(`Usage: bun run scripts/dev-config.ts <port|db_path>`);
  process.exit(1);
}
