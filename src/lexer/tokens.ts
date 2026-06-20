/**
 * Token contract for the MQL5 lexer.
 *
 * The lexer runs AFTER the preprocessor pass (which resolves `#include`,
 * `#define`, `#property`, `#import`). Therefore tokens never carry
 * preprocessor directives — by the time we tokenise, the source is plain
 * MQL5 code. (`#property` values and standard-library `#include <...>`
 * shims are recorded separately by the preprocessor and attached to the
 * Program node, not emitted as tokens.)
 */

export type TokenKind =
  // literals
  | 'Number' // integer or floating-point literal (value carries the text)
  | 'String' // "..."
  | 'Char' // '.'
  | 'Identifier'
  | 'Keyword'
  // punctuation / structure
  | 'LParen'
  | 'RParen'
  | 'LBrace'
  | 'RBrace'
  | 'LBracket'
  | 'RBracket'
  | 'Semicolon'
  | 'Comma'
  | 'Dot'
  | 'Scope' // ::
  // operators
  | 'Operator'
  | 'EOF';

/** Reserved words in the MQL5 subset we parse. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  // declaration modifiers
  'input', 'sinput', 'extern', 'const', 'static', 'virtual', 'override',
  'public', 'private', 'protected',
  // type keywords
  'void', 'bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint',
  'long', 'ulong', 'float', 'double', 'string', 'color', 'datetime',
  'enum', 'struct', 'class', 'union', 'template', 'typename',
  // control flow
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return',
  // expression keywords
  'new', 'delete', 'sizeof', 'this', 'operator',
  // literals that are lexed as keywords but lowered to BoolLit / pointer null
  'true', 'false',
]);

/** The set of multi/single char operators, longest-match-first. */
export const OPERATORS: readonly string[] = [
  '<<=', '>>=',
  '->', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', '^', '?', ':',
];

export interface Token {
  kind: TokenKind;
  /** Raw lexeme text (e.g. "iMA", "0.10", "+="). For strings, the *decoded* value. */
  value: string;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** 0-based absolute offset into the (preprocessed) source. */
  pos: number;
}

export function makeToken(
  kind: TokenKind,
  value: string,
  line: number,
  col: number,
  pos: number,
): Token {
  return { kind, value, line, col, pos };
}
