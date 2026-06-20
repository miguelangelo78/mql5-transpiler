/**
 * MQL5 preprocessor.
 *
 * Runs BEFORE the lexer. Handles the directives the PoC subset needs:
 *   - `#property NAME VALUE`  → recorded in `properties`, line blanked.
 *   - `#include <...>`        → system/standard-library include; recorded as
 *                               { system:true, shimmed:true } and NOT inlined
 *                               (the runtime provides the Standard Library).
 *   - `#include "..."`        → user include; inlined if the file exists
 *                               relative to the source dir, else recorded as
 *                               { system:false, shimmed:false } (best-effort).
 *   - `#define NAME VALUE`     → object-like macro; textually substituted.
 *   - `#define NAME(args) ...` → function-like macro; best-effort substitution
 *                               (single-line), otherwise left in place + reported.
 *
 * Every directive line is replaced with a BLANK line so the lexer's line/col
 * numbers stay aligned with the original source — diagnostics keep pointing at
 * the right place.
 *
 * String/char literals and comments are honoured so a `#` or `//` inside a
 * string is never mistaken for a directive (handled by the line scanner).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface PreprocessOptions {
  /** Absolute path of the source file (used to resolve user `#include "..."`). */
  filePath?: string;
  /** Directory user includes are resolved against (defaults to dirname(filePath)). */
  sourceDir?: string;
  /** Guard against include cycles / runaway recursion. */
  _includeStack?: string[];
}

export interface PreprocessProperty {
  name: string;
  value: string;
}

export interface PreprocessInclude {
  path: string;
  system: boolean;
  shimmed: boolean;
}

export interface PreprocessResult {
  /** The fully preprocessed source, line-aligned with the original. */
  code: string;
  properties: PreprocessProperty[];
  includes: PreprocessInclude[];
  /** Non-fatal preprocessing notes (unsupported function-like macros, etc.). */
  warnings: string[];
}

interface ObjectMacro {
  kind: 'object';
  name: string;
  body: string;
}
interface FunctionMacro {
  kind: 'function';
  name: string;
  params: string[];
  body: string;
}
type Macro = ObjectMacro | FunctionMacro;

const IDENT_RE = /[A-Za-z_]\w*/g;
const IDENT_HEAD = /[A-Za-z_]/;

/**
 * Preprocess MQL5 source.
 */
export function preprocess(source: string, opts: PreprocessOptions = {}): PreprocessResult {
  const properties: PreprocessProperty[] = [];
  const includes: PreprocessInclude[] = [];
  const warnings: string[] = [];
  const macros = new Map<string, Macro>();

  const sourceDir =
    opts.sourceDir ?? (opts.filePath ? dirname(opts.filePath) : process.cwd());
  const includeStack = opts._includeStack ?? [];

  const outLines = processLines(source, {
    properties,
    includes,
    warnings,
    macros,
    sourceDir,
    includeStack,
  });

  return {
    code: outLines.join('\n'),
    properties,
    includes,
    warnings,
  };
}

interface Ctx {
  properties: PreprocessProperty[];
  includes: PreprocessInclude[];
  warnings: string[];
  macros: Map<string, Macro>;
  sourceDir: string;
  includeStack: string[];
}

/**
 * Process the source line-by-line. We strip comments only for the purpose of
 * directive detection and macro expansion; the lexer does its own (authoritative)
 * comment stripping, but we must avoid expanding macros inside comments/strings
 * AND avoid treating a `#` inside a string/comment as a directive.
 */
function processLines(source: string, ctx: Ctx): string[] {
  const rawLines = source.split('\n');
  const out: string[] = [];

  // Tracks whether we're inside a /* ... */ block comment that spans lines.
  let inBlockComment = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push(''); // whole line is comment; blank it but keep line count
        continue;
      }
      inBlockComment = false;
      // Replace the comment portion with spaces, keep the rest for processing.
      const rest = line.slice(end + 2);
      const processed = processCodeLine(rest, ctx, out, () => {
        inBlockComment = true;
      });
      out.push(processed ?? '');
      continue;
    }

    // Find the first non-whitespace char to detect a directive.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      handleDirective(line, trimmed, ctx, out);
      continue;
    }

    const processed = processCodeLine(line, ctx, out, () => {
      inBlockComment = true;
    });
    out.push(processed ?? '');
  }

  return out;
}

/**
 * Handle a `#...` directive line. Pushes the (blank or inlined) replacement
 * onto `out`. May push MULTIPLE lines for an inlined user include — in that
 * case it keeps overall correctness (line numbers past the include shift, which
 * is acceptable and matches how real preprocessors behave with inlined files).
 */
function handleDirective(rawLine: string, trimmed: string, ctx: Ctx, out: string[]): void {
  const body = trimmed.slice(1).trimStart(); // after '#'

  if (body.startsWith('property')) {
    const rest = body.slice('property'.length).trim();
    const m = /^([A-Za-z_]\w*)\s*(.*)$/.exec(rest);
    if (m) {
      const value = unquoteIfStringLiteral(stripTrailingComment(m[2]).trim());
      ctx.properties.push({ name: m[1], value });
    }
    out.push('');
    return;
  }

  if (body.startsWith('include')) {
    handleInclude(body.slice('include'.length).trim(), ctx, out);
    return;
  }

  if (body.startsWith('define')) {
    handleDefine(body.slice('define'.length).trim(), ctx);
    out.push('');
    return;
  }

  if (body.startsWith('undef')) {
    const name = body.slice('undef'.length).trim().split(/\s+/)[0];
    if (name) ctx.macros.delete(name);
    out.push('');
    return;
  }

  // #import / #ifdef / #ifndef / #endif / #else / #pragma / #resource ...
  // — recorded as a warning where meaningful, blanked so they don't break the lexer.
  const directiveName = /^[A-Za-z_]\w*/.exec(body)?.[0] ?? '';
  if (directiveName === 'import') {
    ctx.warnings.push(`#import not supported in PoC subset (line blanked): ${trimmed}`);
  } else if (
    directiveName &&
    !['ifdef', 'ifndef', 'if', 'else', 'elif', 'endif', 'pragma', 'resource'].includes(
      directiveName,
    )
  ) {
    ctx.warnings.push(`Unsupported directive '#${directiveName}' (line blanked)`);
  }
  out.push('');
}

function handleInclude(spec: string, ctx: Ctx, out: string[]): void {
  spec = stripTrailingComment(spec).trim();
  // <...> system include
  let m = /^<([^>]*)>/.exec(spec);
  if (m) {
    ctx.includes.push({ path: m[1], system: true, shimmed: true });
    out.push('');
    return;
  }
  // "..." user include
  m = /^"([^"]*)"/.exec(spec);
  if (m) {
    const incPath = m[1];
    const resolved = isAbsolute(incPath) ? incPath : resolve(ctx.sourceDir, incPath);
    if (existsSync(resolved) && !ctx.includeStack.includes(resolved)) {
      // Inline it (recursively preprocessed against its own directory).
      const sub = preprocess(readFileSync(resolved, 'utf8'), {
        filePath: resolved,
        sourceDir: dirname(resolved),
        _includeStack: [...ctx.includeStack, resolved],
      });
      // Carry the sub-include's properties/includes/macros-derived records up.
      ctx.properties.push(...sub.properties);
      ctx.includes.push(...sub.includes);
      ctx.warnings.push(...sub.warnings);
      ctx.includes.push({ path: incPath, system: false, shimmed: false });
      // Replace the directive line with the inlined code (line count grows here).
      out.push(sub.code);
      return;
    }
    // File not found (or cyclic): record as shimmed:false, blank the line.
    ctx.includes.push({ path: incPath, system: false, shimmed: false });
    out.push('');
    return;
  }
  // Malformed include — blank + warn.
  ctx.warnings.push(`Malformed #include: ${spec}`);
  out.push('');
}

function handleDefine(rest: string, ctx: Ctx): void {
  // function-like:  NAME(a, b) body...    (no space between NAME and '(' )
  const fnMatch = /^([A-Za-z_]\w*)\(([^)]*)\)\s*(.*)$/.exec(rest);
  if (fnMatch && rest[fnMatch[1].length] === '(') {
    const name = fnMatch[1];
    const params = fnMatch[2]
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const macroBody = stripTrailingComment(fnMatch[3]).trim();
    ctx.macros.set(name, { kind: 'function', name, params, body: macroBody });
    return;
  }

  // object-like:  NAME body...   (or NAME with empty body)
  const objMatch = /^([A-Za-z_]\w*)\b\s*(.*)$/.exec(rest);
  if (objMatch) {
    const name = objMatch[1];
    const macroBody = stripTrailingComment(objMatch[2]).trim();
    ctx.macros.set(name, { kind: 'object', name, body: macroBody });
  }
}

/**
 * Process a non-directive code line: expand macros while skipping strings,
 * char literals and comments. Returns the rewritten line. Calls `enterBlock`
 * if an unterminated `/* ` block comment begins on this line.
 */
function processCodeLine(
  line: string,
  ctx: Ctx,
  _out: string[],
  enterBlock: () => void,
): string {
  if (ctx.macros.size === 0) {
    // No macros: still need to detect an unterminated block comment for the
    // line-scanner's state, but we don't rewrite anything.
    detectTrailingBlockComment(line, enterBlock);
    return line;
  }
  return expandMacrosInLine(line, ctx, enterBlock);
}

/**
 * Detect whether a `/* ` block comment opens on this line and is left
 * unterminated, so the caller can set inBlockComment. Honours strings.
 */
function detectTrailingBlockComment(line: string, enterBlock: () => void): void {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'") {
      i = skipStringLiteral(line, i);
      continue;
    }
    if (c === '/' && line[i + 1] === '/') return; // line comment: rest is comment
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        enterBlock();
        return;
      }
      i = end + 2;
      continue;
    }
    i++;
  }
}

/**
 * Expand object/function macros in a code line, skipping string/char literals
 * and comments. Iterates to a fixpoint (bounded) so macros referencing macros
 * resolve.
 */
function expandMacrosInLine(line: string, ctx: Ctx, enterBlock: () => void): string {
  let result = '';
  let i = 0;
  let openedBlock = false;

  while (i < line.length) {
    const c = line[i];

    // Strings / chars: copy verbatim.
    if (c === '"' || c === "'") {
      const end = skipStringLiteral(line, i);
      result += line.slice(i, end);
      i = end;
      continue;
    }

    // Line comment: copy rest verbatim, stop.
    if (c === '/' && line[i + 1] === '/') {
      result += line.slice(i);
      i = line.length;
      break;
    }

    // Block comment: copy verbatim (and handle unterminated).
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        result += line.slice(i);
        openedBlock = true;
        i = line.length;
        break;
      }
      result += line.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Identifier: possible macro.
    if (IDENT_HEAD.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(line);
      // m must match at i because IDENT_HEAD matched.
      const ident = m![0];
      const macro = ctx.macros.get(ident);
      if (macro) {
        const expanded = tryExpandMacroAt(macro, line, i, ident.length, ctx);
        if (expanded) {
          // Re-scan from the same position so nested macros expand (bounded by
          // overall progress: we append expanded text and advance past the call).
          result += expandMacrosInText(expanded.text, ctx, 0);
          i = expanded.nextIndex;
          continue;
        }
      }
      result += ident;
      i += ident.length;
      continue;
    }

    result += c;
    i++;
  }

  if (openedBlock) enterBlock();
  return result;
}

/** Expand macros in a plain text fragment (already free of line-level concerns). */
function expandMacrosInText(text: string, ctx: Ctx, depth: number): string {
  if (depth > 32) return text; // recursion guard
  let result = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const end = skipStringLiteral(text, i);
      result += text.slice(i, end);
      i = end;
      continue;
    }
    if (IDENT_HEAD.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(text);
      const ident = m![0];
      const macro = ctx.macros.get(ident);
      if (macro) {
        const expanded = tryExpandMacroAt(macro, text, i, ident.length, ctx);
        if (expanded) {
          result += expandMacrosInText(expanded.text, ctx, depth + 1);
          i = expanded.nextIndex;
          continue;
        }
      }
      result += ident;
      i += ident.length;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

interface ExpansionResult {
  text: string;
  nextIndex: number;
}

function tryExpandMacroAt(
  macro: Macro,
  src: string,
  identStart: number,
  identLen: number,
  ctx: Ctx,
): ExpansionResult | null {
  if (macro.kind === 'object') {
    return { text: macro.body, nextIndex: identStart + identLen };
  }
  // function-like: requires a '(' (optionally after spaces) right after the name.
  let j = identStart + identLen;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
  if (src[j] !== '(') {
    // Used without args — not a call; leave verbatim (real cpp would error, we're lenient).
    ctx.warnings.push(
      `Function-like macro '${macro.name}' used without arguments; left as identifier`,
    );
    return null;
  }
  const argParse = parseMacroArgs(src, j);
  if (!argParse) {
    ctx.warnings.push(`Function-like macro '${macro.name}' arguments not closed on line`);
    return null;
  }
  const { args, end } = argParse;
  if (args.length !== macro.params.length) {
    ctx.warnings.push(
      `Function-like macro '${macro.name}' arity mismatch (expected ${macro.params.length}, got ${args.length}); left unexpanded`,
    );
    return null;
  }
  // Substitute parameters in the body (token-aware: only whole identifiers).
  const text = substituteParams(macro.body, macro.params, args);
  return { text, nextIndex: end };
}

/** Parse `( a, b, c )` starting at the index of '('. Returns args + end index. */
function parseMacroArgs(src: string, openParen: number): { args: string[]; end: number } | null {
  let i = openParen + 1;
  let depth = 1;
  const args: string[] = [];
  let cur = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const end = skipStringLiteral(src, i);
      cur += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(') {
      depth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) {
        const trimmed = cur.trim();
        if (args.length > 0 || trimmed.length > 0) args.push(trimmed);
        return { args, end: i + 1 };
      }
      cur += c;
      i++;
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  return null; // unterminated
}

function substituteParams(body: string, params: string[], args: string[]): string {
  if (params.length === 0) return body;
  const map = new Map<string, string>();
  for (let k = 0; k < params.length; k++) map.set(params[k], args[k]);
  let result = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = skipStringLiteral(body, i);
      result += body.slice(i, end);
      i = end;
      continue;
    }
    if (IDENT_HEAD.test(c)) {
      IDENT_RE.lastIndex = i;
      const m = IDENT_RE.exec(body);
      const ident = m![0];
      if (map.has(ident)) {
        result += map.get(ident)!;
      } else {
        result += ident;
      }
      i += ident.length;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}

/**
 * Given an index at a `"` or `'`, return the index just past the closing quote,
 * honouring `\` escapes. If unterminated, returns end-of-string.
 */
function skipStringLiteral(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return s.length;
}

/**
 * `#property` values that are a single string literal carry the literal's
 * quotes in source (`#property copyright "..."`). MT5 stores the unquoted
 * value, so we strip a single pair of surrounding double quotes and decode the
 * basic escapes. Non-string values (numbers, identifiers) pass through.
 */
function unquoteIfStringLiteral(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    const inner = value.slice(1, -1);
    return inner
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  return value;
}

/** Remove a trailing `// ...` comment from a directive value, honouring strings. */
function stripTrailingComment(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      i = skipStringLiteral(s, i);
      continue;
    }
    if (c === '/' && s[i + 1] === '/') return s.slice(0, i);
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) return s.slice(0, i);
      i = end + 2;
      continue;
    }
    i++;
  }
  return s;
}
