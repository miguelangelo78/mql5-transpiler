/**
 * MQL5 recursive-descent parser.
 *
 * Consumes the preprocessor's Program-level records (properties + includes) and
 * the lexer's Token[], producing the AST from ./ast.ts.
 *
 * Grammar (PoC subset):
 *   top level   := (InputDecl | VarDecl | FunctionDecl | EnumDecl | StructDecl)*
 *   statements  := block | varDecl | if | for | while | do/while | switch
 *                | return | break | continue | exprStmt | emptyStmt
 *   expressions := precedence-climbing over the full C/MQL5 operator table,
 *                  with member `.`, scope `::`, index `[]`, call `()`,
 *                  pre/post `++`/`--`, C-style cast `(type)expr`, new/delete,
 *                  ternary `?:`, right-assoc assignment.
 *
 * Every node carries a Span. Declarations vs expression-statements at the top
 * level and inside blocks are disambiguated by a type-lookahead.
 */

import {
  type AssignOp,
  type BinaryOp,
  type Block,
  type Decl,
  type EnumDecl,
  type Expr,
  type FunctionDecl,
  type IncludeRecord,
  type InputDecl,
  type Param,
  type Program,
  type PropertyRecord,
  type Span,
  type Stmt,
  type StructDecl,
  type SwitchCase,
  type TypeRef,
  type VarDecl,
  type VarDeclarator,
} from './ast';
import { KEYWORDS, type Token, type TokenKind } from '../lexer/tokens';

export interface ParseOptions {
  /** Properties recorded by the preprocessor (attached to Program). */
  properties?: PropertyRecord[];
  /** Includes recorded by the preprocessor (attached to Program). */
  includes?: IncludeRecord[];
}

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
    public readonly pos: number,
  ) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'ParseError';
  }
}

/** The set of keywords that introduce a type. */
const TYPE_KEYWORDS = new Set([
  'void', 'bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint',
  'long', 'ulong', 'float', 'double', 'string', 'color', 'datetime',
]);

const DECL_MODIFIERS = new Set(['const', 'static', 'virtual', 'override', 'extern']);
const ACCESS_MODIFIERS = new Set(['public', 'private', 'protected']);

// ─────────────────────────────────────────────────────────────────────────
// Operator precedence (higher binds tighter). Mirrors C/C++.
// ─────────────────────────────────────────────────────────────────────────
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const ASSIGN_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=',
]);

export function parse(tokens: Token[], opts: ParseOptions = {}): Program {
  return new Parser(tokens, opts).parseProgram();
}

class Parser {
  private i = 0;
  private readonly toks: Token[];

  constructor(
    tokens: Token[],
    private readonly opts: ParseOptions,
  ) {
    this.toks = tokens;
  }

  // ── token cursor ──
  private peek(offset = 0): Token {
    const idx = this.i + offset;
    return idx < this.toks.length ? this.toks[idx] : this.toks[this.toks.length - 1];
  }
  private at(kind: TokenKind, value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }
  private atKeyword(value: string): boolean {
    return this.at('Keyword', value);
  }
  private atOp(value: string): boolean {
    return this.at('Operator', value);
  }
  private next(): Token {
    const t = this.peek();
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  private expect(kind: TokenKind, value?: string): Token {
    if (!this.at(kind, value)) {
      const t = this.peek();
      throw new ParseError(
        `Expected ${value ?? kind} but found '${t.value || t.kind}'`,
        t.line,
        t.col,
        t.pos,
      );
    }
    return this.next();
  }
  private isEOF(): boolean {
    return this.peek().kind === 'EOF';
  }

  private spanFrom(startTok: Token, endTok?: Token): Span {
    const end = endTok ?? this.prevTok();
    return {
      start: startTok.pos,
      end: end.pos + (end.value ? end.value.length : 0),
      line: startTok.line,
      col: startTok.col,
    };
  }
  private prevTok(): Token {
    return this.i > 0 ? this.toks[this.i - 1] : this.toks[0];
  }

  // ── program ──
  parseProgram(): Program {
    const startTok = this.peek();
    const decls: Decl[] = [];
    while (!this.isEOF()) {
      // Skip stray semicolons at top level.
      if (this.at('Semicolon')) {
        this.next();
        continue;
      }
      const decl = this.parseTopLevelDecl();
      if (decl) decls.push(decl);
    }
    const span = this.spanFrom(startTok, this.peek());
    return {
      kind: 'Program',
      properties: this.opts.properties ? [...this.opts.properties] : [],
      includes: this.opts.includes ? [...this.opts.includes] : [],
      decls,
      span,
    };
  }

  private parseTopLevelDecl(): Decl | null {
    // input / sinput
    if (this.atKeyword('input') || this.atKeyword('sinput')) {
      return this.parseInputDecl();
    }
    // extern: may be `extern` input-like decl
    if (this.atKeyword('extern')) {
      return this.parseInputDecl();
    }
    // enum
    if (this.atKeyword('enum')) {
      return this.parseEnumDecl();
    }
    // struct / class
    if (this.atKeyword('struct') || this.atKeyword('class')) {
      return this.parseStructDecl();
    }
    // template — best-effort: skip the template header, parse the following decl.
    if (this.atKeyword('template')) {
      this.skipTemplateHeader();
      return this.parseTopLevelDecl();
    }
    // Otherwise: a typed declaration — could be a function or a global var.
    return this.parseTypedDecl();
  }

  // ── input/extern decl ──
  private parseInputDecl(): InputDecl {
    const startTok = this.next(); // input | sinput | extern
    const modifier = startTok.value as 'input' | 'sinput' | 'extern';
    const type = this.parseType();
    const name = this.expect('Identifier').value;
    let init: Expr | undefined;
    // Array form (rare for inputs) — skip dims into the type sense; PoC keeps scalar.
    if (this.atOp('=')) {
      this.next();
      init = this.parseAssignment();
    }
    this.expect('Semicolon');
    const label = this.consumeTrailingLabel(startTok.line);
    return { kind: 'InputDecl', modifier, type, name, init, label, span: this.spanFrom(startTok) };
  }

  /**
   * MT5 shows the trailing `// comment` on an input line as the input's label.
   * Our lexer has stripped comments, so we cannot read it from tokens. We pass
   * the original line so the comment can be recovered upstream if needed; here
   * we simply return undefined (comments are gone post-lex). The InputDecl.label
   * remains optional. (Kept as a hook; label recovery would require the raw
   * source line, which the lexer dropped — documented limitation.)
   */
  private consumeTrailingLabel(_line: number): string | undefined {
    return undefined;
  }

  // ── enum ──
  private parseEnumDecl(): EnumDecl {
    const startTok = this.expect('Keyword', 'enum');
    const name = this.at('Identifier') ? this.next().value : '';
    this.expect('LBrace');
    const members: { name: string; value?: Expr }[] = [];
    while (!this.at('RBrace') && !this.isEOF()) {
      const memberName = this.expect('Identifier').value;
      let value: Expr | undefined;
      if (this.atOp('=')) {
        this.next();
        value = this.parseAssignment();
      }
      members.push({ name: memberName, value });
      if (this.at('Comma')) this.next();
      else break;
    }
    this.expect('RBrace');
    if (this.at('Semicolon')) this.next();
    return { kind: 'EnumDecl', name, members, span: this.spanFrom(startTok) };
  }

  // ── struct / class ──
  private parseStructDecl(): StructDecl {
    const startTok = this.next(); // struct | class
    const keyword = startTok.value as 'struct' | 'class';
    const name = this.at('Identifier') ? this.next().value : '';

    // Optional inheritance `: public Base`
    let base: string | undefined;
    if (this.at('Operator', ':')) {
      this.next();
      // optional access keyword
      while (this.peek().kind === 'Keyword' && ACCESS_MODIFIERS.has(this.peek().value)) {
        this.next();
      }
      if (this.at('Identifier')) base = this.next().value;
    }

    // Forward declaration `struct Foo;`
    if (this.at('Semicolon')) {
      this.next();
      return { kind: 'StructDecl', keyword, name, base, fields: [], methods: [], span: this.spanFrom(startTok) };
    }

    this.expect('LBrace');
    const fields: VarDecl[] = [];
    const methods: FunctionDecl[] = [];
    while (!this.at('RBrace') && !this.isEOF()) {
      // access labels `public:` etc.
      if (this.peek().kind === 'Keyword' && ACCESS_MODIFIERS.has(this.peek().value)) {
        this.next();
        if (this.at('Operator', ':')) this.next();
        continue;
      }
      if (this.at('Semicolon')) {
        this.next();
        continue;
      }
      // A member: typed decl — function or field. Reuse the typed-decl machinery.
      const member = this.parseTypedDecl({ inClass: true, className: name });
      if (member) {
        if (member.kind === 'FunctionDecl') methods.push(member);
        else if (member.kind === 'VarDecl') fields.push(member);
      }
    }
    this.expect('RBrace');
    if (this.at('Semicolon')) this.next();
    return { kind: 'StructDecl', keyword, name, base, fields, methods, span: this.spanFrom(startTok) };
  }

  /**
   * Parse a typed declaration: either a function (`type name(params) { ... }`)
   * or a variable declaration (`type a, b[3];`). Disambiguated by whether a
   * `(` follows the first declared name (and it isn't a constructor-style call).
   */
  private parseTypedDecl(ctx?: { inClass?: boolean; className?: string }): Decl | null {
    const startTok = this.peek();

    // Leading modifiers (const/static/virtual/override).
    let isStatic = false;
    let isConst = false;
    while (this.peek().kind === 'Keyword' && DECL_MODIFIERS.has(this.peek().value)) {
      const m = this.next().value;
      if (m === 'static') isStatic = true;
      else if (m === 'const') isConst = true;
      // virtual/override/extern: noted but not stored on VarDecl/FunctionDecl in PoC.
    }

    // Constructor/destructor inside a class: `ClassName(...)` or `~ClassName(...)`.
    if (ctx?.inClass) {
      const ctorLike = this.tryParseCtorDtor(startTok, ctx.className!);
      if (ctorLike) return ctorLike;
    }

    const type = this.parseType();
    const name = this.expect('Identifier').value;

    // Function?  `name(` — but distinguish from a var initialised by a constructor
    // call, which MQL5 doesn't have at declaration in this subset, so `(` ⇒ function.
    if (this.at('LParen')) {
      return this.finishFunctionDecl(startTok, type, name);
    }

    // Otherwise: variable declaration with one or more declarators.
    return this.finishVarDecl(startTok, type, name, isStatic, isConst);
  }

  private tryParseCtorDtor(startTok: Token, className: string): FunctionDecl | null {
    // destructor: ~ClassName(
    if (this.atOp('~')) {
      const save = this.i;
      this.next(); // ~
      if (this.at('Identifier') && this.peek().value === className && this.peek(1).kind === 'LParen') {
        this.next(); // ClassName
        const voidType: TypeRef = { name: 'void', pointer: 0, isConst: false, isRef: false };
        return this.finishFunctionDecl(startTok, voidType, '~' + className);
      }
      this.i = save;
      return null;
    }
    // constructor: ClassName(   (Identifier matching className followed by '(')
    if (this.at('Identifier') && this.peek().value === className && this.peek(1).kind === 'LParen') {
      this.next(); // ClassName
      const voidType: TypeRef = { name: 'void', pointer: 0, isConst: false, isRef: false };
      return this.finishFunctionDecl(startTok, voidType, className);
    }
    return null;
  }

  private finishFunctionDecl(startTok: Token, returnType: TypeRef, name: string): FunctionDecl {
    const params = this.parseParamList();
    // Trailing `const` on a method.
    if (this.atKeyword('const')) this.next();
    let body: Block | undefined;
    if (this.at('LBrace')) {
      body = this.parseBlock();
    } else {
      this.expect('Semicolon'); // prototype
    }
    return { kind: 'FunctionDecl', returnType, name, params, body, span: this.spanFrom(startTok) };
  }

  private parseParamList(): Param[] {
    this.expect('LParen');
    const params: Param[] = [];
    if (this.at('RParen')) {
      this.next();
      return params;
    }
    // `void` as the only "param" means no params.
    if (this.atKeyword('void') && this.peek(1).kind === 'RParen') {
      this.next();
      this.next();
      return params;
    }
    while (true) {
      const type = this.parseType();
      // name may be omitted in a prototype; PoC requires it for bodies but tolerates absence.
      let name = '';
      if (this.at('Identifier')) name = this.next().value;
      const arrayDims = this.parseArrayDims();
      let defaultValue: Expr | undefined;
      if (this.atOp('=')) {
        this.next();
        defaultValue = this.parseAssignment();
      }
      params.push({ type, name, arrayDims, defaultValue });
      if (this.at('Comma')) {
        this.next();
        continue;
      }
      break;
    }
    this.expect('RParen');
    return params;
  }

  private finishVarDecl(
    startTok: Token,
    type: TypeRef,
    firstName: string,
    isStatic: boolean,
    isConst: boolean,
  ): VarDecl {
    const declarators: VarDeclarator[] = [];
    declarators.push(this.finishDeclarator(firstName));
    while (this.at('Comma')) {
      this.next();
      // Subsequent declarators may carry their own pointer `*` (rare); skip if present.
      while (this.atOp('*')) this.next();
      const name = this.expect('Identifier').value;
      declarators.push(this.finishDeclarator(name));
    }
    this.expect('Semicolon');
    return {
      kind: 'VarDecl',
      type,
      declarators,
      isStatic,
      isConst: isConst || type.isConst,
      span: this.spanFrom(startTok),
    };
  }

  private finishDeclarator(name: string): VarDeclarator {
    const arrayDims = this.parseArrayDims();
    let init: Expr | undefined;
    if (this.atOp('=')) {
      this.next();
      init = this.parseAssignment();
    } else if (this.at('LParen')) {
      // C++-style constructor init `CFoo foo(args)` — capture args as a synthetic call init.
      // Represented as a NewExpr-free call on the type is out of scope; we store nothing
      // and skip the parens to stay robust. (Object decls like `CTrade trade;` have no init.)
      this.skipBalancedParens();
    }
    return { name, arrayDims, init };
  }

  /** Parse zero or more `[expr]` / `[]` dimensions. */
  private parseArrayDims(): (Expr | null)[] {
    const dims: (Expr | null)[] = [];
    while (this.at('LBracket')) {
      this.next();
      if (this.at('RBracket')) {
        dims.push(null);
      } else {
        dims.push(this.parseExpression());
      }
      this.expect('RBracket');
    }
    return dims;
  }

  // ── types ──
  private parseType(): TypeRef {
    let isConst = false;
    // leading const
    while (this.atKeyword('const')) {
      isConst = true;
      this.next();
    }
    // base type name: a type keyword or an identifier (class/struct/enum name)
    let name: string;
    if (this.peek().kind === 'Keyword' && TYPE_KEYWORDS.has(this.peek().value)) {
      name = this.next().value;
    } else if (this.at('Identifier')) {
      name = this.next().value;
    } else if (this.atKeyword('enum') || this.atKeyword('struct') || this.atKeyword('class')) {
      // `enum Foo` used as a type
      this.next();
      name = this.expect('Identifier').value;
    } else {
      const t = this.peek();
      throw new ParseError(`Expected a type but found '${t.value || t.kind}'`, t.line, t.col, t.pos);
    }
    // trailing const (e.g. `int const`)
    while (this.atKeyword('const')) {
      isConst = true;
      this.next();
    }
    // pointer levels
    let pointer = 0;
    while (this.atOp('*')) {
      pointer++;
      this.next();
    }
    // reference
    let isRef = false;
    if (this.atOp('&')) {
      isRef = true;
      this.next();
    }
    return { name, pointer, isConst, isRef };
  }

  // ── blocks & statements ──
  private parseBlock(): Block {
    const startTok = this.expect('LBrace');
    const statements: Stmt[] = [];
    while (!this.at('RBrace') && !this.isEOF()) {
      statements.push(this.parseStatement());
    }
    this.expect('RBrace');
    return { kind: 'Block', statements, span: this.spanFrom(startTok) };
  }

  private parseStatement(): Stmt {
    const startTok = this.peek();

    if (this.at('LBrace')) return this.parseBlock();
    if (this.at('Semicolon')) {
      this.next();
      return { kind: 'EmptyStmt', span: this.spanFrom(startTok) };
    }

    if (this.peek().kind === 'Keyword') {
      const kw = this.peek().value;
      switch (kw) {
        case 'if':
          return this.parseIf();
        case 'for':
          return this.parseFor();
        case 'while':
          return this.parseWhile();
        case 'do':
          return this.parseDoWhile();
        case 'switch':
          return this.parseSwitch();
        case 'return':
          return this.parseReturn();
        case 'break':
          this.next();
          this.expect('Semicolon');
          return { kind: 'BreakStmt', span: this.spanFrom(startTok) };
        case 'continue':
          this.next();
          this.expect('Semicolon');
          return { kind: 'ContinueStmt', span: this.spanFrom(startTok) };
      }
    }

    // A local declaration? (type/modifier lookahead)
    if (this.looksLikeLocalDecl()) {
      return this.parseLocalVarDecl();
    }

    // Otherwise: an expression statement.
    const expr = this.parseExpression();
    this.expect('Semicolon');
    return { kind: 'ExprStmt', expr, span: this.spanFrom(startTok) };
  }

  /**
   * Lookahead to decide whether the upcoming tokens start a local var decl.
   * True for: a leading decl modifier, a type keyword, OR an identifier that is
   * a type name FOLLOWED by another identifier (e.g. `CTrade trade;`,
   * `MyStruct s;`). This is the classic C declaration/expression ambiguity; we
   * resolve it with the `IDENT IDENT` shape (a type name followed by a var name),
   * which an expression can never produce.
   */
  private looksLikeLocalDecl(): boolean {
    const t0 = this.peek();
    // const/static at statement start → declaration
    if (t0.kind === 'Keyword' && (t0.value === 'const' || t0.value === 'static')) return true;
    // type keyword → declaration
    if (t0.kind === 'Keyword' && TYPE_KEYWORDS.has(t0.value)) return true;
    // identifier type:  IDENT  (* )?  IDENT  ...    → declaration
    if (t0.kind === 'Identifier') {
      let k = 1;
      // skip pointer stars
      while (this.peek(k).kind === 'Operator' && this.peek(k).value === '*') k++;
      // skip `&` ref (uncommon for locals) — not a decl shape, skip
      const t1 = this.peek(k);
      if (t1.kind === 'Identifier') {
        // `IDENT IDENT` — but guard against `a b` being two statements: in valid
        // MQL5 that's only legal as a declaration, so treat as decl.
        return true;
      }
    }
    return false;
  }

  private parseLocalVarDecl(): VarDecl {
    const startTok = this.peek();
    let isStatic = false;
    let isConst = false;
    while (this.peek().kind === 'Keyword' && DECL_MODIFIERS.has(this.peek().value)) {
      const m = this.next().value;
      if (m === 'static') isStatic = true;
      else if (m === 'const') isConst = true;
    }
    const type = this.parseType();
    const firstName = this.expect('Identifier').value;
    return this.finishVarDecl(startTok, type, firstName, isStatic, isConst);
  }

  private parseIf(): Stmt {
    const startTok = this.expect('Keyword', 'if');
    this.expect('LParen');
    const cond = this.parseExpression();
    this.expect('RParen');
    const then = this.parseStatement();
    let elseStmt: Stmt | undefined;
    if (this.atKeyword('else')) {
      this.next();
      elseStmt = this.parseStatement();
    }
    return { kind: 'IfStmt', cond, then, else: elseStmt, span: this.spanFrom(startTok) };
  }

  private parseFor(): Stmt {
    const startTok = this.expect('Keyword', 'for');
    this.expect('LParen');
    let init: VarDecl | { kind: 'ExprStmt'; expr: Expr; span: Span } | undefined;
    if (this.at('Semicolon')) {
      this.next();
    } else if (this.looksLikeLocalDecl()) {
      init = this.parseLocalVarDecl(); // consumes the trailing ';'
    } else {
      const exprStartTok = this.peek();
      const expr = this.parseExpression();
      this.expect('Semicolon');
      init = { kind: 'ExprStmt', expr, span: this.spanFrom(exprStartTok) };
    }
    let cond: Expr | undefined;
    if (!this.at('Semicolon')) cond = this.parseExpression();
    this.expect('Semicolon');
    let update: Expr | undefined;
    if (!this.at('RParen')) update = this.parseExpression();
    this.expect('RParen');
    const body = this.parseStatement();
    return { kind: 'ForStmt', init, cond, update, body, span: this.spanFrom(startTok) };
  }

  private parseWhile(): Stmt {
    const startTok = this.expect('Keyword', 'while');
    this.expect('LParen');
    const cond = this.parseExpression();
    this.expect('RParen');
    const body = this.parseStatement();
    return { kind: 'WhileStmt', cond, body, span: this.spanFrom(startTok) };
  }

  private parseDoWhile(): Stmt {
    const startTok = this.expect('Keyword', 'do');
    const body = this.parseStatement();
    this.expect('Keyword', 'while');
    this.expect('LParen');
    const cond = this.parseExpression();
    this.expect('RParen');
    this.expect('Semicolon');
    return { kind: 'DoWhileStmt', body, cond, span: this.spanFrom(startTok) };
  }

  private parseSwitch(): Stmt {
    const startTok = this.expect('Keyword', 'switch');
    this.expect('LParen');
    const disc = this.parseExpression();
    this.expect('RParen');
    this.expect('LBrace');
    const cases: SwitchCase[] = [];
    while (!this.at('RBrace') && !this.isEOF()) {
      let test: Expr | undefined;
      if (this.atKeyword('case')) {
        this.next();
        test = this.parseExpression();
        this.expect('Operator', ':');
      } else if (this.atKeyword('default')) {
        this.next();
        this.expect('Operator', ':');
      } else {
        const t = this.peek();
        throw new ParseError(
          `Expected 'case' or 'default' in switch but found '${t.value || t.kind}'`,
          t.line,
          t.col,
          t.pos,
        );
      }
      const body: Stmt[] = [];
      while (
        !this.atKeyword('case') &&
        !this.atKeyword('default') &&
        !this.at('RBrace') &&
        !this.isEOF()
      ) {
        body.push(this.parseStatement());
      }
      cases.push({ test, body });
    }
    this.expect('RBrace');
    return { kind: 'SwitchStmt', disc, cases, span: this.spanFrom(startTok) };
  }

  private parseReturn(): Stmt {
    const startTok = this.expect('Keyword', 'return');
    let value: Expr | undefined;
    if (!this.at('Semicolon')) {
      // MQL5 allows `return(x);` — the parens are part of the expression.
      value = this.parseExpression();
    }
    this.expect('Semicolon');
    return { kind: 'ReturnStmt', value, span: this.spanFrom(startTok) };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Expressions — precedence climbing
  // ─────────────────────────────────────────────────────────────────────

  /** Full expression, including the comma operator? MQL5 PoC: no comma operator. */
  private parseExpression(): Expr {
    return this.parseAssignment();
  }

  /** Assignment is right-associative and lowest precedence (above ternary). */
  private parseAssignment(): Expr {
    const left = this.parseTernary();
    if (this.peek().kind === 'Operator' && ASSIGN_OPS.has(this.peek().value)) {
      const opTok = this.next();
      const value = this.parseAssignment(); // right-assoc
      return {
        kind: 'AssignExpr',
        op: opTok.value as AssignOp,
        target: left,
        value,
        span: this.mergeSpan(left, value),
      };
    }
    return left;
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(0);
    if (this.atOp('?')) {
      this.next();
      const then = this.parseAssignment();
      this.expect('Operator', ':');
      const els = this.parseAssignment();
      return { kind: 'TernaryExpr', cond, then, else: els, span: this.mergeSpan(cond, els) };
    }
    return cond;
  }

  /** Precedence-climbing for binary operators. */
  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    while (true) {
      const t = this.peek();
      if (t.kind !== 'Operator') break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      // assignment / ternary handled at higher levels — never enter here.
      this.next();
      // Left-associative: parse the right side with prec+1.
      const right = this.parseBinary(prec + 1);
      left = {
        kind: 'BinaryExpr',
        op: t.value as BinaryOp,
        left,
        right,
        span: this.mergeSpan(left, right),
      };
    }
    return left;
  }

  /** Prefix unary, C-style cast, new/delete, sizeof. */
  private parseUnary(): Expr {
    const startTok = this.peek();

    // new T(args)
    if (this.atKeyword('new')) {
      this.next();
      const type = this.parseType();
      let args: Expr[] = [];
      if (this.at('LParen')) {
        args = this.parseArgList();
      }
      return { kind: 'NewExpr', type, args, span: this.spanFrom(startTok) };
    }
    // delete operand
    if (this.atKeyword('delete')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'DeleteExpr', operand, span: this.spanFrom(startTok) };
    }
    // sizeof(...) — represented as a call to a pseudo-identifier so downstream sees an expr.
    if (this.atKeyword('sizeof')) {
      this.next();
      let inner: Expr;
      this.expect('LParen');
      // sizeof(type) or sizeof(expr) — both parse the inner as expression-ish;
      // a bare type becomes an Identifier expr.
      if (this.isTypeAhead()) {
        const type = this.parseType();
        inner = { kind: 'Identifier', name: type.name, span: this.spanFrom(startTok) };
      } else {
        inner = this.parseExpression();
      }
      this.expect('RParen');
      return {
        kind: 'CallExpr',
        callee: { kind: 'Identifier', name: 'sizeof', span: this.spanFrom(startTok) },
        args: [inner],
        span: this.spanFrom(startTok),
      };
    }

    // prefix ++ / --
    if (this.atOp('++') || this.atOp('--')) {
      const opTok = this.next();
      const operand = this.parseUnary();
      return {
        kind: 'UnaryExpr',
        op: opTok.value as '++' | '--',
        operand,
        prefix: true,
        span: this.spanFrom(startTok),
      };
    }

    // unary + - ! ~ * &
    if (
      this.atOp('+') ||
      this.atOp('-') ||
      this.atOp('!') ||
      this.atOp('~') ||
      this.atOp('*') ||
      this.atOp('&')
    ) {
      const opTok = this.next();
      const operand = this.parseUnary();
      return {
        kind: 'UnaryExpr',
        op: opTok.value as '+' | '-' | '!' | '~' | '*' | '&',
        operand,
        prefix: true,
        span: this.spanFrom(startTok),
      };
    }

    // C-style cast: `( type ) unary`  — only when the parens enclose a pure type.
    if (this.at('LParen') && this.isCastAhead()) {
      this.next(); // (
      const type = this.parseType();
      this.expect('RParen');
      const expr = this.parseUnary();
      return { kind: 'CastExpr', type, expr, span: this.spanFrom(startTok) };
    }

    return this.parsePostfix();
  }

  /** Postfix: call (), index [], member ., scope :: (on primary), post ++/--. */
  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.at('LParen')) {
        const args = this.parseArgList();
        expr = { kind: 'CallExpr', callee: expr, args, span: this.mergeSpanTok(expr, this.prevTok()) };
        continue;
      }
      if (this.at('LBracket')) {
        this.next();
        const index = this.parseExpression();
        this.expect('RBracket');
        expr = { kind: 'IndexExpr', array: expr, index, span: this.mergeSpanTok(expr, this.prevTok()) };
        continue;
      }
      if (this.at('Dot')) {
        this.next();
        const member = this.expectMemberName();
        expr = { kind: 'MemberAccess', object: expr, member, span: this.mergeSpanTok(expr, this.prevTok()) };
        continue;
      }
      if (this.at('Scope')) {
        // Scope on an already-parsed primary that is a bare identifier → ScopeResolution.
        this.next();
        const name = this.expectMemberName();
        if (expr.kind === 'Identifier') {
          expr = {
            kind: 'ScopeResolution',
            scope: expr.name,
            name,
            span: this.mergeSpanTok(expr, this.prevTok()),
          };
        } else {
          // chained scope (rare) — fold into a member access for robustness.
          expr = { kind: 'MemberAccess', object: expr, member: name, span: this.mergeSpanTok(expr, this.prevTok()) };
        }
        continue;
      }
      if (this.atOp('++') || this.atOp('--')) {
        const opTok = this.next();
        expr = {
          kind: 'UnaryExpr',
          op: opTok.value as '++' | '--',
          operand: expr,
          prefix: false,
          span: this.mergeSpanTok(expr, opTok),
        };
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    // parenthesised expression
    if (this.at('LParen')) {
      this.next();
      const e = this.parseExpression();
      this.expect('RParen');
      return e;
    }

    // number
    if (this.at('Number')) {
      this.next();
      return this.makeNumber(t);
    }

    // string
    if (this.at('String')) {
      this.next();
      return { kind: 'StringLit', value: t.value, span: this.spanFrom(t) };
    }

    // char
    if (this.at('Char')) {
      this.next();
      return { kind: 'CharLit', value: decodeCharLiteral(t.value), span: this.spanFrom(t) };
    }

    // true / false
    if (this.atKeyword('true') || this.atKeyword('false')) {
      this.next();
      return { kind: 'BoolLit', value: t.value === 'true', span: this.spanFrom(t) };
    }

    // this — treat as an identifier reference
    if (this.atKeyword('this')) {
      this.next();
      return { kind: 'Identifier', name: 'this', span: this.spanFrom(t) };
    }

    // A type keyword used as a function-style cast/conversion, e.g. `int(x)`.
    if (t.kind === 'Keyword' && TYPE_KEYWORDS.has(t.value)) {
      this.next();
      if (this.at('LParen')) {
        this.next();
        const expr = this.parseExpression();
        this.expect('RParen');
        return {
          kind: 'CastExpr',
          type: { name: t.value, pointer: 0, isConst: false, isRef: false },
          expr,
          span: this.spanFrom(t),
        };
      }
      // bare type keyword as expression (e.g. inside sizeof handled elsewhere)
      return { kind: 'Identifier', name: t.value, span: this.spanFrom(t) };
    }

    // identifier
    if (this.at('Identifier')) {
      this.next();
      return { kind: 'Identifier', name: t.value, span: this.spanFrom(t) };
    }

    throw new ParseError(
      `Unexpected token '${t.value || t.kind}' in expression`,
      t.line,
      t.col,
      t.pos,
    );
  }

  private parseArgList(): Expr[] {
    this.expect('LParen');
    const args: Expr[] = [];
    if (this.at('RParen')) {
      this.next();
      return args;
    }
    while (true) {
      args.push(this.parseAssignment());
      if (this.at('Comma')) {
        this.next();
        continue;
      }
      break;
    }
    this.expect('RParen');
    return args;
  }

  /** Member name after `.` / `::` — may be an identifier or an `operator` overload, etc. */
  private expectMemberName(): string {
    if (this.at('Identifier')) return this.next().value;
    // operator overloads / keyword-ish members are out of PoC scope; accept identifier only.
    const t = this.peek();
    throw new ParseError(`Expected member name but found '${t.value || t.kind}'`, t.line, t.col, t.pos);
  }

  // ── lookahead helpers ──

  /** True if the cursor is positioned at the start of a type (for sizeof/cast inner). */
  private isTypeAhead(): boolean {
    const t = this.peek();
    if (t.kind === 'Keyword' && (TYPE_KEYWORDS.has(t.value) || t.value === 'const')) return true;
    return false;
  }

  /**
   * Decide if `( ... )` at the cursor is a C-style cast rather than a
   * parenthesised expression. A cast is: `(` TYPE `)` where TYPE is a type
   * keyword or a known-type identifier, with only `*`/`const`/`&` decoration,
   * immediately followed by `)`. We require a *type keyword* (or `Ident`
   * followed directly by `)` and then a unary-startable token) to avoid
   * misreading `(x)+1` as a cast.
   */
  private isCastAhead(): boolean {
    // cursor is at '('
    let k = 1;
    let sawConst = false;
    // const?
    while (this.peek(k).kind === 'Keyword' && this.peek(k).value === 'const') {
      sawConst = true;
      k++;
    }
    const t = this.peek(k);
    let isType = false;
    if (t.kind === 'Keyword' && TYPE_KEYWORDS.has(t.value)) {
      isType = true;
      k++;
    } else if (t.kind === 'Identifier') {
      // identifier type only if followed by `)` (optionally after `*`), and the
      // token AFTER the `)` can start a unary expression. This is the heuristic
      // boundary; we keep it tight to avoid swallowing `(expr)`.
      let kk = k + 1;
      while (this.peek(kk).kind === 'Operator' && this.peek(kk).value === '*') kk++;
      if (this.peek(kk).kind === 'RParen') {
        // peek past the close paren
        const after = this.peek(kk + 1);
        if (this.canStartUnary(after)) {
          return true;
        }
      }
      return sawConst ? true : false;
    } else {
      return false;
    }
    // consumed a type keyword; skip pointer stars / trailing const / &
    while (
      (this.peek(k).kind === 'Operator' && (this.peek(k).value === '*' || this.peek(k).value === '&')) ||
      (this.peek(k).kind === 'Keyword' && this.peek(k).value === 'const')
    ) {
      k++;
    }
    return isType && this.peek(k).kind === 'RParen';
  }

  private canStartUnary(t: Token): boolean {
    switch (t.kind) {
      case 'Number':
      case 'String':
      case 'Char':
      case 'Identifier':
      case 'LParen':
        return true;
      case 'Keyword':
        return (
          t.value === 'true' ||
          t.value === 'false' ||
          t.value === 'this' ||
          t.value === 'new' ||
          TYPE_KEYWORDS.has(t.value)
        );
      case 'Operator':
        return ['+', '-', '!', '~', '*', '&', '++', '--'].includes(t.value);
      default:
        return false;
    }
  }

  // ── misc helpers ──

  private makeNumber(t: Token): Expr {
    const raw = t.value;
    const lower = raw.toLowerCase();
    const isHex = lower.startsWith('0x');
    const isFloat = !isHex && (raw.includes('.') || /[eE]/.test(raw));
    let value: number;
    if (isHex) {
      value = parseInt(raw.replace(/[uUlL]+$/, ''), 16);
    } else {
      value = parseFloat(raw.replace(/[fFlLuU]+$/, ''));
    }
    return { kind: 'NumberLit', raw, value, isFloat, span: this.spanFrom(t) };
  }

  private mergeSpan(a: Expr, b: Expr): Span {
    return {
      start: a.span.start,
      end: b.span.end,
      line: a.span.line,
      col: a.span.col,
    };
  }
  private mergeSpanTok(a: Expr, end: Token): Span {
    return {
      start: a.span.start,
      end: end.pos + (end.value ? end.value.length : 0),
      line: a.span.line,
      col: a.span.col,
    };
  }

  // Skip a `template<...>` header (balanced angle brackets).
  private skipTemplateHeader(): void {
    this.expect('Keyword', 'template');
    if (this.atOp('<')) {
      let depth = 0;
      // angle brackets are operators; count < and >
      do {
        const t = this.next();
        if (t.kind === 'Operator' && t.value === '<') depth++;
        else if (t.kind === 'Operator' && t.value === '>') depth--;
        else if (t.kind === 'Operator' && t.value === '>>') depth -= 2;
        if (this.isEOF()) break;
      } while (depth > 0);
    }
  }

  private skipBalancedParens(): void {
    this.expect('LParen');
    let depth = 1;
    while (depth > 0 && !this.isEOF()) {
      const t = this.next();
      if (t.kind === 'LParen') depth++;
      else if (t.kind === 'RParen') depth--;
    }
  }
}

/** Decode a char-literal inner lexeme (e.g. `A`, `\n`, `\x41`) to its code point. */
function decodeCharLiteral(inner: string): number {
  if (inner.length === 0) return 0;
  if (inner[0] !== '\\') return inner.charCodeAt(0);
  const esc = inner[1];
  switch (esc) {
    case 'n':
      return 10;
    case 't':
      return 9;
    case 'r':
      return 13;
    case '0':
      return 0;
    case '\\':
      return 92;
    case "'":
      return 39;
    case '"':
      return 34;
    case 'b':
      return 8;
    case 'f':
      return 12;
    case 'v':
      return 11;
    case 'a':
      return 7;
    case 'x':
      return parseInt(inner.slice(2), 16) || 0;
    case 'u':
      return parseInt(inner.slice(2), 16) || 0;
    default:
      return esc ? esc.charCodeAt(0) : 0;
  }
}

// re-export KEYWORDS sanity guard so a stale tokens.ts surfaces at import.
void KEYWORDS;
