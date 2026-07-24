#!/usr/bin/env bun
/**
 * dev-port-allocator.ts
 *
 * Executable port allocator used by Paseo (via worktree.servicePorts.portScript)
 * and internally by Plexus dev server scripts to ensure consistent, reliable
 * port assignment whether started via Paseo or standalone.
 *
 * Usage:
 *   # As Paseo portScript:
 *   scripts/dev-port-allocator.ts [serviceName] [workspaceId] [branchName] [worktreePath]
 *
 *   # Standalone / CLI:
 *   bun run scripts/dev-port-allocator.ts
 */

import { basename } from 'path';

/**
 * Derives a stable, deterministic TCP port number (10000-19999) based on the
 * worktree directory name and optional service script name.
 */
export function deriveDevPort(cwd = process.cwd(), scriptName = ''): string {
  if (process.env.PORT) return process.env.PORT;
  const key = scriptName ? `${basename(cwd)}:${scriptName}` : basename(cwd);
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return String(10000 + (Math.abs(hash) % 10000));
}

if (import.meta.main) {
  // Paseo passes positional args: [scriptName, workspaceId, branchName, worktreePath]
  // process.argv[2] is scriptName
  const scriptName =
    process.env.PASEO_SCRIPTNAME || (process.argv.length >= 3 ? process.argv[2] : '');
  const worktreePath =
    process.env.PASEO_WORKTREE_PATH ||
    (process.argv.length >= 6 ? process.argv[5] : undefined) ||
    process.cwd();

  const port = deriveDevPort(worktreePath, scriptName);
  console.log(port);
}
