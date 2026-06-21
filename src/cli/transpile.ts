/**
 * `transpile` CLI — MQL5 source → a TypeScript ES module on disk.
 *
 *   npm run transpile -- <path/to/file.mq5> [outDir]
 *
 * Reads the .mq5, runs the frontend (compileMql5ToIR) + the TypeScript backend
 * (emitTypeScript), writes the result to `<outDir>/<name>.ts` (outDir defaults
 * to ./out, created if missing), and prints the output path.
 *
 * The emitted module exports `createExpert(rt, inputs?)` (the emission ABI in
 * ../ir/nodes.ts) — runnable by the engine driver / the `poc` + `backtest` CLIs.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, dirname, resolve, join } from 'node:path';

import { isMainModule } from './isMain';

import { compileMql5ToIR } from '../compile';
import { emitTypeScript } from '../backend/typescript/emit';
import { checkCoverage } from '../runtime/coverage';
import { type Diagnostic, formatDiagnostics, hasErrors } from '../diagnostics';

export interface TranspileResult {
  /** Absolute path of the emitted .ts module. */
  outPath: string;
  /** The emitted TypeScript source. */
  code: string;
  /** Module name (derived from the input filename). */
  name: string;
  /**
   * All diagnostics for this compile: lowering (unresolved names / unknown
   * calls) + carried preprocessor warnings + runtime-coverage findings
   * (recognised-but-unimplemented builtins). Merged in source-then-coverage
   * order. An error-severity entry means the emitted module would fail at run
   * time; the CLI exits non-zero when any error is present.
   */
  diagnostics: Diagnostic[];
}

/**
 * Transpile a single .mq5 file to a .ts module on disk.
 *
 * @param srcPath  path to the .mq5 source (absolute or relative to cwd)
 * @param outDir   directory for the emitted module (default ./out)
 */
export function transpileFile(srcPath: string, outDir = 'out'): TranspileResult {
  const absSrc = resolve(srcPath);
  const source = readFileSync(absSrc, 'utf8');

  const name = basename(absSrc, extname(absSrc));
  const mod = compileMql5ToIR(source, {
    name,
    filePath: absSrc,
    sourceDir: dirname(absSrc),
  });

  // Merge frontend diagnostics (lowering + preprocessor) with the runtime
  // coverage check (recognised-but-unimplemented builtins — the landmine).
  const diagnostics: Diagnostic[] = [...(mod.diagnostics ?? []), ...checkCoverage(mod)];

  const code = emitTypeScript(mod);

  // If there are error-severity diagnostics the emitted module WILL throw at
  // run time. The CLI also exits non-zero, but a consumer that reads out/X.ts
  // directly (ignoring the exit code) must still be warned — so banner the file
  // (§21: never hand back broken output that looks runnable).
  const banner = hasErrors(diagnostics)
    ? '// ⚠️ DO NOT RUN — this module has error-level diagnostics and will throw\n' +
      '// at run time. Re-transpile after fixing the reported diagnostics.\n\n'
    : '';

  const absOutDir = resolve(outDir);
  mkdirSync(absOutDir, { recursive: true });
  const outPath = join(absOutDir, `${name}.ts`);
  writeFileSync(outPath, banner + code, 'utf8');

  return { outPath, code, name, diagnostics };
}

/** CLI entry: read argv, transpile, print the output path. */
function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('usage: tsx src/cli/transpile.ts <file.mq5> [outDir]\n');
    process.exit(2);
  }
  const srcPath = args[0]!;
  const outDir = args[1] ?? 'out';
  const { outPath, diagnostics } = transpileFile(srcPath, outDir);
  process.stdout.write(`Transpiled → ${outPath}\n`);

  // Report diagnostics loudly. Errors (unresolved name / unknown call /
  // unimplemented builtin) mean the emitted module would fail at run time:
  // print them to stderr and exit non-zero so the gap is impossible to miss.
  if (diagnostics.length > 0) {
    const text = formatDiagnostics(diagnostics);
    const sink = hasErrors(diagnostics) ? process.stderr : process.stdout;
    sink.write('\n' + text + '\n');
  }
  if (hasErrors(diagnostics)) {
    process.stderr.write(
      '\nTranspilation produced ERROR diagnostics — the emitted module would ' +
        'fail at run time. Fix the EA or extend the runtime before running it.\n',
    );
    process.exit(1);
  }
}

// Run when invoked directly (tsx src/cli/transpile.ts ...). Guarded so importing
// this module (e.g. from the poc CLI) does not trigger the CLI.
if (isMainModule(import.meta.url)) {
  main();
}
