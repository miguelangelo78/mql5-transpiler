/**
 * Diagnostics — the honesty layer.
 *
 * A `Diagnostic` is a single compile-time finding the transpiler surfaces to
 * the user INSTEAD of silently emitting code that throws at run time. The
 * canonical landmine (per the completeness critic): a recognised MQL5 builtin
 * that is present in the intrinsic table — so it transpiles cleanly — but is
 * NOT implemented in the runtime, so the emitted code throws an opaque
 * `TypeError`/`Error` the first time that builtin is hit. We catch that at
 * compile time and report it loudly (§21: report what we cannot do; never fake
 * a verification or paper over a gap).
 *
 * This module is intentionally dependency-light: it imports ONLY the `Span`
 * type from the parser AST so a diagnostic can point back at the original
 * `.mq5` source. It has no runtime / lowering dependencies, so both the
 * frontend (lower.ts) and the runtime-coverage check (coverage.ts) can produce
 * `Diagnostic`s without creating an import cycle.
 */

import type { Span } from './parser/ast';

/** Severity of a diagnostic. `error` is fatal policy; `warning`/`info` are advisory. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * The diagnostic codes this transpiler emits. Stable identifiers so tooling and
 * tests can assert on a specific finding without string-matching the message.
 *
 *  - `MQL_UNRESOLVED_NAME`     — an identifier that resolves to nothing (not an
 *                                input/global/local/param/enum-member/context-
 *                                var/builtin-const). It would be `undefined` at
 *                                run time.
 *  - `MQL_UNKNOWN_CALL`        — a free-function call whose callee is neither a
 *                                user function nor a recognised builtin. It
 *                                would throw `TypeError: name is not a function`.
 *  - `MQL_UNKNOWN_METHOD`      — a method call on a recognised stdlib class
 *                                (e.g. CTrade) where the method is NOT part of
 *                                that class's known surface. The runtime object
 *                                has no such method, so it throws at run time.
 *  - `MQL_UNIMPLEMENTED_BUILTIN` — a builtin that IS recognised (in the
 *                                intrinsic table) but is NOT implemented in the
 *                                runtime (a throwing stub or absent). THIS is
 *                                the 59-intrinsic landmine. ALSO covers a
 *                                recognised Standard-Library CLASS (CiMA,
 *                                CArrayObj, …) that the runtime does not yet
 *                                provide — using it would lower to `new
 *                                rt.<Class>(...)` against an undefined ctor and
 *                                throw at run time, so it is flagged here too.
 *  - `MQL_UNSUPPORTED_OVERLOAD` — two or more free functions OR two or more
 *                                methods of the same class share a name
 *                                (MQL5/C++ overloading). The transpiler keeps
 *                                only ONE definition per name (no arity/type
 *                                dispatch), so the others would be silently
 *                                dropped — we report it LOUDLY instead (§21).
 *  - `MQL_UNSUPPORTED_CONSTRUCT` — a syntactic construct the parser recognises
 *                                but does not lower (an out-of-line method
 *                                definition `void Class::method(){…}`, or an
 *                                `operator` overload). The parser skips it
 *                                cleanly and records this diagnostic rather than
 *                                throwing an opaque ParseError (§21).
 *  - `MQL_PREPROCESSOR`        — a best-effort preprocessor note (unsupported
 *                                directive / function-like-macro caveat).
 *                                Advisory (`warning`), not fatal.
 */
export type DiagnosticCode =
  | 'MQL_UNRESOLVED_NAME'
  | 'MQL_UNKNOWN_CALL'
  | 'MQL_UNKNOWN_METHOD'
  | 'MQL_UNIMPLEMENTED_BUILTIN'
  | 'MQL_UNSUPPORTED_OVERLOAD'
  | 'MQL_UNSUPPORTED_CONSTRUCT'
  | 'MQL_PREPROCESSOR';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code (see DiagnosticCode). */
  code: DiagnosticCode;
  /** Human-readable, actionable message. */
  message: string;
  /** Source location, when known (frontend diagnostics carry it). */
  span?: Span;
  /** The symbol/name the diagnostic is about (identifier, call name, builtin). */
  symbol?: string;
}

/** True if any diagnostic in the list is error-severity (the fatal policy gate). */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** Count diagnostics by severity. */
export function countBySeverity(
  diagnostics: readonly Diagnostic[],
): { error: number; warning: number; info: number } {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity]++;
  return counts;
}

/** Format a single diagnostic as one line: `severity[CODE] line N: message`. */
export function formatDiagnostic(d: Diagnostic): string {
  const loc = d.span ? ` line ${d.span.line}` : '';
  return `  ${d.severity}[${d.code}]${loc}: ${d.message}`;
}

/**
 * Format a list of diagnostics for the console, grouped by severity (errors
 * first), with a trailing summary line. Returns an empty string when the list
 * is empty so callers can `if (text) print(text)`.
 *
 * The ordering inside each group is source order if spans are present (stable —
 * we do NOT reorder when spans are absent), so the report reads top-to-bottom.
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return '';

  const order: DiagnosticSeverity[] = ['error', 'warning', 'info'];
  const lines: string[] = [];
  for (const sev of order) {
    const group = diagnostics.filter((d) => d.severity === sev);
    if (group.length === 0) continue;
    const sorted = [...group].sort((a, b) => {
      const la = a.span?.line ?? Number.MAX_SAFE_INTEGER;
      const lb = b.span?.line ?? Number.MAX_SAFE_INTEGER;
      return la - lb;
    });
    lines.push(`${sev === 'error' ? 'Errors' : sev === 'warning' ? 'Warnings' : 'Info'} (${group.length}):`);
    for (const d of sorted) lines.push(formatDiagnostic(d));
  }

  const c = countBySeverity(diagnostics);
  lines.push(`Diagnostics: ${c.error} error(s), ${c.warning} warning(s), ${c.info} info.`);
  return lines.join('\n');
}
