/**
 * True when the given module is the process entry point — i.e. the file was run
 * directly as a CLI (`tsx src/cli/run.ts …`), false when it's imported as a
 * library or bundled into another app.
 *
 * The guard matters because every CLI file uses this to decide whether to run
 * its `main()` at import time. When the package is BUNDLED (e.g. by esbuild into
 * an Electron app), `import.meta.url` can be `undefined`, and the old
 * `fileURLToPath(import.meta.url)` form threw `ERR_INVALID_ARG_TYPE` at import —
 * crashing any consumer that bundled the package. This returns `false` safely in
 * that case (so `main()` never runs on import), and stays exact under tsx.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl: string | undefined): boolean {
  if (typeof metaUrl !== 'string' || process.argv[1] === undefined) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
