/**
 * Language-neutral IR for the MQL5 transpiler.
 *
 * Semantic analysis lowers the AST (../parser/ast.ts) into this IR. Unlike
 * the AST, the IR is RESOLVED: every identifier is bound to what it refers
 * to, every call is classified (user function vs runtime intrinsic vs
 * method), and every I/O-performing call is marked async. Backends walk the
 * IR and emit target code; they never see the AST.
 *
 * ── The emission ABI (the contract every backend + the runtime share) ──────
 *
 * A transpiled program is emitted as a single factory function:
 *
 *     export function createExpert(rt: Runtime, inputs?: Partial<Inputs>) {
 *       // inputs  → `let` with defaults, overridable via `inputs`
 *       // globals → `let` / `const`
 *       // user functions + event handlers → (async) function decls
 *       return { OnInit, OnTick, OnDeinit, OnTimer, ... , __inputs };
 *     }
 *
 * `rt` (the Runtime) exposes EVERYTHING the MQL5 program needs:
 *   - constants:     rt.INVALID_HANDLE, rt.MODE_SMA, rt.PRICE_CLOSE,
 *                    rt.INIT_SUCCEEDED, rt.POSITION_TYPE_BUY, ...
 *   - context vars:  rt._Symbol, rt._Period, rt._Digits, rt._Point  (getters)
 *   - free builtins: rt.iMA(...), rt.CopyBuffer(...), rt.Print(...),
 *                    rt.ArraySetAsSeries(...), rt.PositionSelect(...), ...
 *   - classes:       rt.CTrade  (constructed as `new rt.CTrade(rt)`)
 *
 * Emission rules the backend follows from the IR:
 *   - IRRef{builtinConst|contextVar} X        → `rt.X`
 *   - IRCall target=intrinsic name=f isAsync   → `(await )rt.f(args)`
 *   - IRCall target=method m isAsync           → `(await )receiver.m(args)`
 *   - IRNew CTrade                             → `new rt.CTrade(rt, args)`
 *   - a function whose body contains any async call is emitted `async`,
 *     and every async call site is `await`ed. (Propagated to callers.)
 */

import type { Diagnostic } from '../diagnostics';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type IRPrim =
  | 'int' | 'long' | 'uint' | 'ulong' | 'short' | 'ushort' | 'char' | 'uchar'
  | 'double' | 'float' | 'bool' | 'string' | 'datetime' | 'color' | 'void'
  | 'handle'; // indicator handle — an int alias kept distinct for clarity

export interface IRType {
  /** Primitive kind, if primitive. */
  prim?: IRPrim;
  /** Named type (class/struct/enum), e.g. 'CTrade', 'ENUM_MA_METHOD'. */
  named?: string;
  /** Element type when this is an array. */
  arrayOf?: IRType;
  /** Object-pointer type. */
  pointer?: boolean;
}

export const T = {
  int: { prim: 'int' } as IRType,
  double: { prim: 'double' } as IRType,
  bool: { prim: 'bool' } as IRType,
  string: { prim: 'string' } as IRType,
  void: { prim: 'void' } as IRType,
  handle: { prim: 'handle' } as IRType,
  unknown: {} as IRType,
};

// ─────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────

/** Standard MQL5 event handlers we recognise and the harness may drive. */
export type EventName =
  | 'OnInit' | 'OnDeinit' | 'OnTick' | 'OnTimer' | 'OnTrade'
  | 'OnStart' | 'OnChartEvent' | 'OnCalculate' | 'OnBookEvent';

export interface IRModule {
  /** Source program name (from filename / #property). */
  name: string;
  inputs: IRInput[];
  globals: IRGlobal[];
  functions: IRFunction[];
  /**
   * User-defined classes/structs WITH methods, lowered to real TS classes by
   * the backend. Additive/optional: pre-existing producers/consumers that don't
   * set or read it are unaffected (treated as `[]`). A struct/class with only
   * fields and no methods does NOT need to appear here — it is still usable as a
   * plain value type — but the lowerer emits one whenever the source declared a
   * `class`/`struct` body (so `new`, methods, and field defaults all work).
   */
  classes?: IRClass[];
  /** Names of runtime builtins/constants referenced (for diagnostics + tree-shaking). */
  usedBuiltins: string[];
  /** Map of recognised event handlers present → their function name. */
  events: Partial<Record<EventName, string>>;
  /**
   * Compile-time diagnostics collected during lowering (unresolved names,
   * unknown calls, carried-up preprocessor warnings). Additive, optional field:
   * pre-existing producers/consumers that don't set or read it are unaffected.
   * Runtime-coverage diagnostics (recognised-but-unimplemented builtins) are
   * computed separately by `checkCoverage` (../runtime/coverage.ts) and merged
   * by the CLIs — they are NOT attached here, to keep the frontend pure.
   */
  diagnostics?: Diagnostic[];
}

export interface IRInput {
  name: string;
  type: IRType;
  /** Default value expression (constant-folded where possible). */
  init?: IRExpr;
  label?: string;
}

export interface IRGlobal {
  name: string;
  type: IRType;
  init?: IRExpr;
  isConst: boolean;
  isStatic: boolean;
  /** Array dimension sizes (constant-folded); empty for scalars. */
  arrayDims: (IRExpr | null)[];
}

export interface IRParam {
  name: string;
  type: IRType;
  isArray: boolean;
  /** MQL5 passes arrays and `&` params by reference. */
  byRef: boolean;
  defaultValue?: IRExpr;
}

export interface IRFunction {
  name: string;
  returnType: IRType;
  params: IRParam[];
  body: IRBlock;
  /** True ⇒ emitted `async` and its call sites `await`ed. */
  isAsync: boolean;
  /** The standard event this function implements, if any. */
  event?: EventName;
}

// ─────────────────────────────────────────────────────────────────────────
// User classes / structs (with methods)
// ─────────────────────────────────────────────────────────────────────────

/** A field of a user class/struct → a TS class property with a zero default. */
export interface IRField {
  name: string;
  type: IRType;
  /** Constant-folded init, if the source field had one. */
  init?: IRExpr;
  /** Array dimension sizes (constant-folded); empty for scalars. */
  arrayDims: (IRExpr | null)[];
}

/**
 * A method of a user class/struct → a TS class method. Same async discipline
 * as IRFunction: a method that (transitively) trades is `isAsync` and its call
 * sites are awaited. `isCtor`/`isDtor` mark the constructor / destructor.
 */
export interface IRMethod {
  name: string;
  returnType: IRType;
  params: IRParam[];
  body: IRBlock;
  isAsync: boolean;
  /** `true` for the constructor (`ClassName(...)`). */
  isCtor: boolean;
  /** `true` for the destructor (`~ClassName(...)`). */
  isDtor: boolean;
}

/**
 * A user-defined class or struct lowered to a real TS class. Single inheritance
 * via `base` → `extends base`. Templates are handled by ERASURE: `templateParams`
 * records the type-param names (for documentation/diagnostics) but the body is
 * emitted un-monomorphised, with the type params treated as untyped.
 */
export interface IRClass {
  name: string;
  /** 'struct' | 'class' (semantically identical for emission). */
  keyword: 'struct' | 'class';
  /** Single base class name, if any → `extends base`. */
  base?: string;
  fields: IRField[];
  methods: IRMethod[];
  /** Template type-param names; non-empty ⇒ this was a `template<...>` decl. */
  templateParams: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Intrinsic classification
// ─────────────────────────────────────────────────────────────────────────

/** Which provider (or the host runtime) services a builtin. */
export type IntrinsicProvider = 'broker' | 'feed' | 'clock' | 'host';

export interface IntrinsicInfo {
  provider: IntrinsicProvider;
  /** Runtime method name on `rt` (or on a builtin object for methods). */
  name: string;
  /** True ⇒ the call performs I/O and must be awaited. */
  isAsync: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────────────────

export type IRStmt =
  | IRBlock
  | IRVarDecl
  | IRExprStmt
  | IRIf
  | IRFor
  | IRWhile
  | IRDoWhile
  | IRReturn
  | IRBreak
  | IRContinue
  | IRSwitch;

export interface IRBlock { kind: 'Block'; body: IRStmt[]; }

export interface IRVarDecl {
  kind: 'VarDecl';
  name: string;
  type: IRType;
  init?: IRExpr;
  /** Array dimension sizes (constant-folded); empty for scalars. */
  arrayDims: (IRExpr | null)[];
  isConst: boolean;
}

export interface IRExprStmt { kind: 'ExprStmt'; expr: IRExpr; }
export interface IRIf { kind: 'If'; cond: IRExpr; then: IRStmt; else?: IRStmt; }
export interface IRFor {
  kind: 'For';
  init?: IRVarDecl | IRExprStmt;
  cond?: IRExpr;
  update?: IRExpr;
  body: IRStmt;
}
export interface IRWhile { kind: 'While'; cond: IRExpr; body: IRStmt; }
export interface IRDoWhile { kind: 'DoWhile'; body: IRStmt; cond: IRExpr; }
export interface IRReturn { kind: 'Return'; value?: IRExpr; }
export interface IRBreak { kind: 'Break'; }
export interface IRContinue { kind: 'Continue'; }
export interface IRSwitch {
  kind: 'Switch';
  disc: IRExpr;
  cases: { test?: IRExpr; body: IRStmt[] }[];
}

// ─────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────

export type IRExpr =
  | IRNum
  | IRStr
  | IRBool
  | IRRef
  | IRMember
  | IRIndex
  | IRCall
  | IRNew
  | IRDelete
  | IRUnary
  | IRBinary
  | IRAssign
  | IRTernary
  | IRCast;

export interface IRNum { kind: 'Num'; value: number; isFloat: boolean; type: IRType; }
export interface IRStr { kind: 'Str'; value: string; type: IRType; }
export interface IRBool { kind: 'Bool'; value: boolean; type: IRType; }

/** A resolved name reference. */
export type IRRefBinding =
  | { kind: 'input'; name: string }
  | { kind: 'global'; name: string }
  | { kind: 'local'; name: string }
  | { kind: 'param'; name: string }
  /** Compile-time constant builtin: INVALID_HANDLE, MODE_SMA, INIT_SUCCEEDED, ... */
  | { kind: 'builtinConst'; name: string }
  /** Runtime context variable: _Symbol, _Period, _Digits, _Point. */
  | { kind: 'contextVar'; name: string }
  /** Enum member of a user enum. */
  | { kind: 'enumMember'; enumName: string; name: string }
  /** The `this` receiver inside a user-class method → emitted bare `this`. */
  | { kind: 'thisRef' };

export interface IRRef { kind: 'Ref'; binding: IRRefBinding; type: IRType; }

export interface IRMember { kind: 'Member'; object: IRExpr; member: string; type: IRType; }
export interface IRIndex { kind: 'Index'; array: IRExpr; index: IRExpr; type: IRType; }

/** A classified call. */
export type IRCallTarget =
  | { kind: 'user'; name: string }
  | { kind: 'intrinsic'; info: IntrinsicInfo }
  | { kind: 'method'; receiver: IRExpr; method: string; info?: IntrinsicInfo };

export interface IRCall {
  kind: 'Call';
  target: IRCallTarget;
  args: IRExpr[];
  /** Convenience mirror of target async-ness; emitter awaits when true. */
  isAsync: boolean;
  type: IRType;
}

export interface IRNew { kind: 'New'; typeName: string; args: IRExpr[]; type: IRType; }
export interface IRDelete { kind: 'Delete'; operand: IRExpr; type: IRType; }

export interface IRUnary {
  kind: 'Unary';
  op: '+' | '-' | '!' | '~' | '++' | '--' | '*' | '&';
  operand: IRExpr;
  prefix: boolean;
  type: IRType;
}

export interface IRBinary {
  kind: 'Binary';
  op: '+' | '-' | '*' | '/' | '%'
    | '==' | '!=' | '<' | '>' | '<=' | '>='
    | '&&' | '||' | '&' | '|' | '^' | '<<' | '>>';
  left: IRExpr;
  right: IRExpr;
  /** True when this is integer division/modulo (MQL5 truncates toward zero). */
  intArith: boolean;
  type: IRType;
}

export interface IRAssign {
  kind: 'Assign';
  op: '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=';
  target: IRExpr;
  value: IRExpr;
  type: IRType;
}

export interface IRTernary { kind: 'Ternary'; cond: IRExpr; then: IRExpr; else: IRExpr; type: IRType; }
export interface IRCast { kind: 'Cast'; to: IRType; expr: IRExpr; type: IRType; }
