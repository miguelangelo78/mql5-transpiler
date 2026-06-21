/**
 * Load a transpiled EA's `createExpert` factory — independent of any TypeScript
 * loader, so the package runs an EA under plain Node (an Electron main process, a
 * server, a script), not just under `tsx`.
 *
 * Emitted EA modules are **pure JavaScript with zero imports** (`createExpert`
 * takes the runtime `rt` as a parameter and references nothing else — verified
 * across every example), so we import the code via a `data:` URL. No temp file,
 * no transform, no dependency: the emitted source IS valid JS, and a `data:`
 * module needs no base-URL resolution because it imports nothing.
 */

import { readFile } from 'node:fs/promises';
import type { ExpertFactory } from './runtime/runtime';

/** Load a `createExpert` factory from emitted EA **source code** (in memory). */
export async function loadExpertFromCode(code: string): Promise<ExpertFactory> {
  const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);
  const mod = (await import(url)) as { createExpert?: unknown };
  if (typeof mod.createExpert !== 'function') {
    throw new Error('emitted module does not export a createExpert function');
  }
  return mod.createExpert as ExpertFactory;
}

/** Load a `createExpert` factory from an emitted EA **file** on disk. */
export async function loadEmittedExpert(modulePath: string): Promise<ExpertFactory> {
  return loadExpertFromCode(await readFile(modulePath, 'utf8'));
}
