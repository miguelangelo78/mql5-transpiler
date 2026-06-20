/**
 * AST contract for the MQL5 frontend.
 *
 * This is the *syntactic* tree the parser produces — it is NOT yet
 * semantically resolved (no symbol binding, no overload resolution, no
 * intrinsic classification). Semantic analysis consumes this tree and
 * lowers it to the IR (see ../ir/nodes.ts).
 *
 * Every node carries `kind` (a string discriminant) and a source span so
 * later passes and diagnostics can point back at the original `.mq5`.
 *
 * Scope of the PoC subset (intentionally a slice of full MQL5):
 *   - top level: #property/#include records, input decls, global var decls,
 *     function decls, enum decls, simple struct/class decls.
 *   - statements: block, var decl, expr, if/else, for, while, do/while,
 *     return, break, continue, switch.
 *   - expressions: literals, identifiers, member access (`a.b`), scope
 *     resolution (`A::b`), indexing (`a[i]`), calls, new/delete, unary,
 *     binary, assignment, ternary, C-style cast (`(int)x`).
 */

export interface Span {
  /** 0-based start offset, inclusive. */
  start: number;
  /** 0-based end offset, exclusive. */
  end: number;
  line: number;
  col: number;
}

/** A type reference as written in source (not yet resolved to a runtime type). */
export interface TypeRef {
  /** Base type name, e.g. "int", "double", "string", "CTrade", "MyStruct". */
  name: string;
  /** Number of `*` pointer levels (MQL5 object pointers). */
  pointer: number;
  /** `const` qualifier present. */
  isConst: boolean;
  /** `&` reference (used on parameters). */
  isRef: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Program & top-level declarations
// ─────────────────────────────────────────────────────────────────────────

export interface Program {
  kind: 'Program';
  /** `#property name value` records, in source order. */
  properties: PropertyRecord[];
  /** Resolved/shimmed includes (standard-lib `<...>` are shimmed, not inlined). */
  includes: IncludeRecord[];
  /** Top-level declarations in source order. */
  decls: Decl[];
  span: Span;
}

export interface PropertyRecord { name: string; value: string; }
export interface IncludeRecord {
  /** e.g. "Trade/Trade.mqh". */
  path: string;
  /** `<...>` = system/standard-library; `"..."` = user/local. */
  system: boolean;
  /** True if the include was shimmed to a runtime builtin rather than inlined. */
  shimmed: boolean;
}

export type Decl =
  | InputDecl
  | VarDecl
  | FunctionDecl
  | EnumDecl
  | StructDecl;

/** `input`/`sinput`/`extern` tunable parameter. */
export interface InputDecl {
  kind: 'InputDecl';
  /** 'input' | 'sinput' | 'extern' */
  modifier: 'input' | 'sinput' | 'extern';
  type: TypeRef;
  name: string;
  init?: Expr;
  /** Trailing `// comment` (MT5 shows it as the input's label). */
  label?: string;
  span: Span;
}

/** A variable declaration. Used both at global scope and (inside a Block) for locals. */
export interface VarDecl {
  kind: 'VarDecl';
  type: TypeRef;
  /** One or more declarators (MQL5 allows `double a[], b;`). */
  declarators: VarDeclarator[];
  isStatic: boolean;
  isConst: boolean;
  span: Span;
}

export interface VarDeclarator {
  name: string;
  /** Array dimensions; `[]` (unsized) is represented as `null` in the list. */
  arrayDims: (Expr | null)[];
  init?: Expr;
}

export interface Param {
  type: TypeRef;
  name: string;
  /** `[]` array parameter dims. */
  arrayDims: (Expr | null)[];
  defaultValue?: Expr;
}

export interface FunctionDecl {
  kind: 'FunctionDecl';
  returnType: TypeRef;
  name: string;
  params: Param[];
  /** undefined = forward declaration / prototype (no body). */
  body?: Block;
  /**
   * Template type-parameter names when this function was introduced by a
   * `template<typename T, ...>` header. Empty for a plain function. Optional/
   * additive: pre-existing producers that don't set it are unaffected (treated
   * as `[]`). Erasure semantics — see lower.ts.
   */
  templateParams?: string[];
  span: Span;
}

export interface EnumDecl {
  kind: 'EnumDecl';
  name: string;
  members: { name: string; value?: Expr }[];
  span: Span;
}

export interface StructDecl {
  kind: 'StructDecl';
  /** 'struct' | 'class' */
  keyword: 'struct' | 'class';
  name: string;
  base?: string;
  fields: VarDecl[];
  methods: FunctionDecl[];
  /**
   * Template type-parameter names when this decl was introduced by a
   * `template<typename T, ...>` header (e.g. `['T']`). Empty for a plain class.
   * Templates are handled by ERASURE (see lower.ts): the body is emitted
   * un-monomorphised with the type params treated as untyped. Additive field;
   * a plain (non-template) StructDecl leaves it `[]`.
   */
  templateParams: string[];
  span: Span;
}

// ─────────────────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────────────────

export type Stmt =
  | Block
  | VarDecl
  | ExprStmt
  | IfStmt
  | ForStmt
  | WhileStmt
  | DoWhileStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | SwitchStmt
  | EmptyStmt;

export interface Block { kind: 'Block'; statements: Stmt[]; span: Span; }
export interface ExprStmt { kind: 'ExprStmt'; expr: Expr; span: Span; }
export interface EmptyStmt { kind: 'EmptyStmt'; span: Span; }

export interface IfStmt {
  kind: 'IfStmt';
  cond: Expr;
  then: Stmt;
  else?: Stmt;
  span: Span;
}

export interface ForStmt {
  kind: 'ForStmt';
  /** VarDecl | ExprStmt | undefined */
  init?: VarDecl | ExprStmt;
  cond?: Expr;
  update?: Expr;
  body: Stmt;
  span: Span;
}

export interface WhileStmt { kind: 'WhileStmt'; cond: Expr; body: Stmt; span: Span; }
export interface DoWhileStmt { kind: 'DoWhileStmt'; body: Stmt; cond: Expr; span: Span; }
export interface ReturnStmt { kind: 'ReturnStmt'; value?: Expr; span: Span; }
export interface BreakStmt { kind: 'BreakStmt'; span: Span; }
export interface ContinueStmt { kind: 'ContinueStmt'; span: Span; }

export interface SwitchStmt {
  kind: 'SwitchStmt';
  disc: Expr;
  cases: SwitchCase[];
  span: Span;
}
export interface SwitchCase {
  /** undefined = `default:` */
  test?: Expr;
  body: Stmt[];
}

// ─────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────

export type Expr =
  | NumberLit
  | StringLit
  | BoolLit
  | CharLit
  | Identifier
  | MemberAccess
  | ScopeResolution
  | IndexExpr
  | CallExpr
  | NewExpr
  | DeleteExpr
  | UnaryExpr
  | BinaryExpr
  | AssignExpr
  | TernaryExpr
  | CastExpr;

export interface NumberLit {
  kind: 'NumberLit';
  /** Raw text, e.g. "0.10", "10", "0x1F". */
  raw: string;
  /** Parsed numeric value. */
  value: number;
  /** True if it had a decimal point / exponent (double vs int). */
  isFloat: boolean;
  span: Span;
}
export interface StringLit { kind: 'StringLit'; value: string; span: Span; }
export interface BoolLit { kind: 'BoolLit'; value: boolean; span: Span; }
export interface CharLit { kind: 'CharLit'; value: number; span: Span; }

export interface Identifier { kind: 'Identifier'; name: string; span: Span; }

/** `object.member` (MQL5 uses `.` for both value and pointer member access). */
export interface MemberAccess {
  kind: 'MemberAccess';
  object: Expr;
  member: string;
  span: Span;
}

/** `Scope::name` — enum/static/namespace qualification. */
export interface ScopeResolution {
  kind: 'ScopeResolution';
  scope: string;
  name: string;
  span: Span;
}

export interface IndexExpr { kind: 'IndexExpr'; array: Expr; index: Expr; span: Span; }

export interface CallExpr {
  kind: 'CallExpr';
  /** Identifier (free function) or MemberAccess (method call). */
  callee: Expr;
  args: Expr[];
  span: Span;
}

export interface NewExpr { kind: 'NewExpr'; type: TypeRef; args: Expr[]; span: Span; }
export interface DeleteExpr { kind: 'DeleteExpr'; operand: Expr; span: Span; }

export interface UnaryExpr {
  kind: 'UnaryExpr';
  op: '+' | '-' | '!' | '~' | '++' | '--' | '*' | '&';
  operand: Expr;
  /** true = prefix (`++x`), false = postfix (`x++`). */
  prefix: boolean;
  span: Span;
}

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '>' | '<=' | '>='
  | '&&' | '||'
  | '&' | '|' | '^' | '<<' | '>>';

export interface BinaryExpr {
  kind: 'BinaryExpr';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  span: Span;
}

export type AssignOp =
  | '=' | '+=' | '-=' | '*=' | '/=' | '%='
  | '&=' | '|=' | '^=' | '<<=' | '>>=';

export interface AssignExpr {
  kind: 'AssignExpr';
  op: AssignOp;
  target: Expr;
  value: Expr;
  span: Span;
}

export interface TernaryExpr {
  kind: 'TernaryExpr';
  cond: Expr;
  then: Expr;
  else: Expr;
  span: Span;
}

/** C-style cast `(int)expr` / `(double)(expr)`. */
export interface CastExpr { kind: 'CastExpr'; type: TypeRef; expr: Expr; span: Span; }
