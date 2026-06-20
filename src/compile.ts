/**
 * Front-half compiler entry point.
 *
 * `compileMql5ToIR(source, { name })` runs the full frontend pipeline:
 *   preprocess → tokenize → parse → lower
 * and returns the language-neutral IRModule the backends consume.
 *
 * `parseProgram(source, { name? })` stops at the AST (preprocess → tokenize →
 * parse), for callers that want the syntactic tree (tests, tooling).
 */

import { preprocess, type PreprocessOptions } from './lexer/preprocessor';
import { tokenize } from './lexer/lexer';
import { parse } from './parser/parser';
import { lower } from './sema/lower';
import type { Program } from './parser/ast';
import type { IRModule } from './ir/nodes';
import type { Diagnostic } from './diagnostics';

export interface CompileOptions {
  /** Module name (becomes IRModule.name). */
  name: string;
  /** Absolute path of the source (for resolving user `#include "..."`). */
  filePath?: string;
  /** Directory user includes resolve against (defaults to dirname(filePath)). */
  sourceDir?: string;
}

export interface ParseProgramOptions {
  name?: string;
  filePath?: string;
  sourceDir?: string;
}

/**
 * Compile MQL5 source all the way to the IR, with diagnostics attached.
 *
 * Runs the full frontend inline (rather than via `parseProgram`) so it can
 * capture the preprocessor's non-fatal warnings — which `parseProgram` discards
 * — and carry them into `module.diagnostics` as advisory `MQL_PREPROCESSOR`
 * warnings, alongside the lowering diagnostics (unresolved names / unknown
 * calls). Runtime-coverage findings (recognised-but-unimplemented builtins) are
 * computed separately by `checkCoverage` and merged by the CLIs, to keep this
 * frontend pure of runtime knowledge.
 */
export function compileMql5ToIR(source: string, opts: CompileOptions): IRModule {
  const ppOpts: PreprocessOptions = {
    filePath: opts.filePath,
    sourceDir: opts.sourceDir,
  };
  const pp = preprocess(source, ppOpts);
  const tokens = tokenize(pp.code);
  const program = parse(tokens, {
    properties: pp.properties,
    includes: pp.includes,
  });
  const mod = lower(program, { name: opts.name });

  // Carry preprocessor warnings into the module's diagnostics (advisory). The
  // preprocessor does not track spans for its notes, so these have no span.
  const ppDiagnostics: Diagnostic[] = pp.warnings.map((message) => ({
    severity: 'warning' as const,
    code: 'MQL_PREPROCESSOR' as const,
    message,
  }));
  if (ppDiagnostics.length > 0) {
    mod.diagnostics = [...ppDiagnostics, ...(mod.diagnostics ?? [])];
  }

  return mod;
}

/** Run preprocess + tokenize + parse and return the AST Program. */
export function parseProgram(source: string, opts: ParseProgramOptions = {}): Program {
  const ppOpts: PreprocessOptions = {
    filePath: opts.filePath,
    sourceDir: opts.sourceDir,
  };
  const pp = preprocess(source, ppOpts);
  const tokens = tokenize(pp.code);
  const program = parse(tokens, {
    properties: pp.properties,
    includes: pp.includes,
  });
  return program;
}
