/**
 * MQL5 lexer.
 *
 * Consumes the PREPROCESSED source (no directives remain) and produces a flat
 * Token[] per ./tokens.ts, ending in an EOF token. Comments are stripped.
 *
 * Lexical rules:
 *   - whitespace + `// line` + `/* block * /` comments are skipped.
 *   - Numbers: decimal int, hex (0x..), float with `.`/exponent, optional
 *     numeric suffixes (f/F, l/L, u/U) which MQL5 accepts. `value` carries the
 *     raw lexeme; the parser parses the numeric value.
 *   - Strings: `"..."` with C escapes → `value` is the DECODED string.
 *   - Chars:   `'.'` with escapes → `value` is the raw inner lexeme text.
 *   - Identifiers/keywords: `[A-Za-z_]\w*`; classified Keyword if in KEYWORDS.
 *   - Operators: longest-match from OPERATORS. Structural punctuation
 *     (parens/braces/brackets/`;`/`,`/`.`/`::`) get their own TokenKind.
 *
 * Line/col are 1-based; pos is the 0-based absolute offset.
 */

import { KEYWORDS, OPERATORS, makeToken, type Token, type TokenKind } from './tokens';

export interface LexError {
  message: string;
  line: number;
  col: number;
  pos: number;
}

export class LexerError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
    public readonly pos: number,
  ) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'LexerError';
  }
}

// Punctuation single-chars that map to a dedicated TokenKind.
const PUNCT: Record<string, TokenKind> = {
  '(': 'LParen',
  ')': 'RParen',
  '{': 'LBrace',
  '}': 'RBrace',
  '[': 'LBracket',
  ']': 'RBracket',
  ';': 'Semicolon',
  ',': 'Comma',
};

// Operators sorted longest-first for greedy matching (defensive — OPERATORS is
// already ordered, but we don't depend on that ordering).
const OPS_SORTED: readonly string[] = [...OPERATORS].sort((a, b) => b.length - a.length);

export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const len = code.length;

  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      if (code[pos] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      pos++;
    }
  };

  while (pos < len) {
    const c = code[pos];

    // ── whitespace ──
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      advance();
      continue;
    }

    // ── line comment ──
    if (c === '/' && code[pos + 1] === '/') {
      while (pos < len && code[pos] !== '\n') advance();
      continue;
    }

    // ── block comment ──
    if (c === '/' && code[pos + 1] === '*') {
      advance(2);
      while (pos < len && !(code[pos] === '*' && code[pos + 1] === '/')) advance();
      if (pos < len) advance(2); // consume */
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startPos = pos;

    // ── number ──
    if (isDigit(c) || (c === '.' && isDigit(code[pos + 1]))) {
      const value = readNumber(code, pos);
      advance(value.length);
      tokens.push(makeToken('Number', value, startLine, startCol, startPos));
      continue;
    }

    // ── string ──
    if (c === '"') {
      const { decoded, consumed } = readString(code, pos, startLine, startCol);
      advance(consumed);
      tokens.push(makeToken('String', decoded, startLine, startCol, startPos));
      continue;
    }

    // ── char literal ──
    if (c === "'") {
      const { inner, consumed } = readChar(code, pos, startLine, startCol);
      advance(consumed);
      tokens.push(makeToken('Char', inner, startLine, startCol, startPos));
      continue;
    }

    // ── identifier / keyword ──
    if (isIdentStart(c)) {
      let end = pos + 1;
      while (end < len && isIdentPart(code[end])) end++;
      const word = code.slice(pos, end);
      advance(word.length);
      const kind: TokenKind = KEYWORDS.has(word) ? 'Keyword' : 'Identifier';
      tokens.push(makeToken(kind, word, startLine, startCol, startPos));
      continue;
    }

    // ── scope resolution :: ──
    if (c === ':' && code[pos + 1] === ':') {
      advance(2);
      tokens.push(makeToken('Scope', '::', startLine, startCol, startPos));
      continue;
    }

    // ── dot (member access) — but not a number-leading dot (handled above) ──
    if (c === '.') {
      advance();
      tokens.push(makeToken('Dot', '.', startLine, startCol, startPos));
      continue;
    }

    // ── dedicated punctuation ──
    const punctKind = PUNCT[c];
    if (punctKind) {
      advance();
      tokens.push(makeToken(punctKind, c, startLine, startCol, startPos));
      continue;
    }

    // ── operators (longest match) ──
    const op = matchOperator(code, pos);
    if (op) {
      advance(op.length);
      tokens.push(makeToken('Operator', op, startLine, startCol, startPos));
      continue;
    }

    // Unknown character — fail loudly rather than silently skip (§21: no faking).
    throw new LexerError(`Unexpected character '${c}'`, startLine, startCol, startPos);
  }

  tokens.push(makeToken('EOF', '', line, col, pos));
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}
function isHexDigit(c: string | undefined): boolean {
  return (
    c !== undefined &&
    ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
  );
}
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/** Read a numeric lexeme starting at `start`. Returns the raw text. */
function readNumber(code: string, start: number): string {
  let i = start;
  const len = code.length;

  // Hex literal.
  if (code[i] === '0' && (code[i + 1] === 'x' || code[i + 1] === 'X')) {
    i += 2;
    while (i < len && isHexDigit(code[i])) i++;
    // hex suffix (u/U/l/L) tolerated
    while (i < len && /[uUlL]/.test(code[i])) i++;
    return code.slice(start, i);
  }

  // Decimal / float.
  while (i < len && isDigit(code[i])) i++;
  if (code[i] === '.') {
    i++;
    while (i < len && isDigit(code[i])) i++;
  }
  // Exponent.
  if (code[i] === 'e' || code[i] === 'E') {
    let j = i + 1;
    if (code[j] === '+' || code[j] === '-') j++;
    if (isDigit(code[j])) {
      i = j;
      while (i < len && isDigit(code[i])) i++;
    }
  }
  // Numeric suffixes (f/F/l/L/u/U), MQL5 tolerant.
  while (i < len && /[fFlLuU]/.test(code[i])) i++;

  return code.slice(start, i);
}

/** Read a `"..."` string starting at the opening quote. Returns decoded text + chars consumed. */
function readString(
  code: string,
  start: number,
  line: number,
  col: number,
): { decoded: string; consumed: number } {
  let i = start + 1;
  let out = '';
  const len = code.length;
  while (i < len) {
    const c = code[i];
    if (c === '\\') {
      const { value, len: escLen } = decodeEscape(code, i);
      out += value;
      i += escLen;
      continue;
    }
    if (c === '"') {
      return { decoded: out, consumed: i - start + 1 };
    }
    if (c === '\n') break; // unterminated on this line
    out += c;
    i++;
  }
  throw new LexerError('Unterminated string literal', line, col, start);
}

/** Read a `'.'` char literal. Returns the inner lexeme (raw, undecoded) + chars consumed. */
function readChar(
  code: string,
  start: number,
  line: number,
  col: number,
): { inner: string; consumed: number } {
  let i = start + 1;
  const len = code.length;
  let inner = '';
  while (i < len) {
    const c = code[i];
    if (c === '\\') {
      inner += code.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      return { inner, consumed: i - start + 1 };
    }
    if (c === '\n') break;
    inner += c;
    i++;
  }
  throw new LexerError('Unterminated char literal', line, col, start);
}

/** Decode a `\x` escape at index `i` (which points at the backslash). */
function decodeEscape(code: string, i: number): { value: string; len: number } {
  const next = code[i + 1];
  switch (next) {
    case 'n':
      return { value: '\n', len: 2 };
    case 't':
      return { value: '\t', len: 2 };
    case 'r':
      return { value: '\r', len: 2 };
    case '0':
      return { value: '\0', len: 2 };
    case '\\':
      return { value: '\\', len: 2 };
    case '"':
      return { value: '"', len: 2 };
    case "'":
      return { value: "'", len: 2 };
    case 'b':
      return { value: '\b', len: 2 };
    case 'f':
      return { value: '\f', len: 2 };
    case 'v':
      return { value: '\v', len: 2 };
    case 'a':
      return { value: '\x07', len: 2 };
    case 'x': {
      // \xHH..
      let j = i + 2;
      let hex = '';
      while (hex.length < 4 && isHexDigit(code[j])) {
        hex += code[j];
        j++;
      }
      if (hex.length === 0) return { value: 'x', len: 2 };
      return { value: String.fromCharCode(parseInt(hex, 16)), len: j - i };
    }
    case 'u': {
      // \uHHHH
      let j = i + 2;
      let hex = '';
      while (hex.length < 4 && isHexDigit(code[j])) {
        hex += code[j];
        j++;
      }
      if (hex.length === 0) return { value: 'u', len: 2 };
      return { value: String.fromCharCode(parseInt(hex, 16)), len: j - i };
    }
    default:
      // Unknown escape — keep the char as-is (lenient).
      return { value: next ?? '', len: 2 };
  }
}

/** Longest-match an operator from OPS_SORTED at `pos`. */
function matchOperator(code: string, pos: number): string | null {
  for (const op of OPS_SORTED) {
    if (code.startsWith(op, pos)) return op;
  }
  return null;
}
