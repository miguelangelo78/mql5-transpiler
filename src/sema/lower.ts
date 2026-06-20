/**
 * Semantic analysis + lowering: AST (../parser/ast.ts) → IR (../ir/nodes.ts).
 *
 * Responsibilities:
 *   - Build scoped symbol tables (globals, inputs, function params, locals,
 *     enum members, stdlib object decls).
 *   - Resolve every Identifier to an IRRefBinding (input/global/local/param/
 *     builtinConst/contextVar/enumMember).
 *   - Classify every CallExpr:
 *       callee Identifier in the intrinsic table → intrinsic
 *       callee Identifier is a user function     → user
 *       callee MemberAccess obj.method           → method {receiver, info?}
 *         (if obj's declared type is a stdlib class — CTrade — attach the
 *          method's IntrinsicInfo)
 *   - Mirror each call's async-ness onto IRCall.isAsync.
 *   - Compute IRFunction.isAsync via a FIXPOINT: a function is async if it
 *     transitively contains any async call (intrinsic-async OR a call to an
 *     async user function). Re-iterate until stable.
 *   - Map MQL5 types → IRType; constant-fold trivial input defaults / array dims.
 *   - Populate events (OnInit/OnTick/...) and usedBuiltins.
 *   - Mark integer division/modulo (`intArith`) when both operands are integer.
 */

import {
  type AssignExpr,
  type BinaryExpr,
  type Block,
  type CallExpr,
  type Decl,
  type EnumDecl,
  type Expr,
  type FunctionDecl,
  type InputDecl,
  type MemberAccess,
  type Param,
  type Program,
  type Span,
  type Stmt,
  type StructDecl,
  type TypeRef,
  type VarDecl,
} from '../parser/ast';
import type { Diagnostic } from '../diagnostics';
import {
  T,
  type EventName,
  type IRBlock,
  type IRCall,
  type IRCallTarget,
  type IRClass,
  type IRExpr,
  type IRField,
  type IRFor,
  type IRFunction,
  type IRGlobal,
  type IRInput,
  type IRMethod,
  type IRModule,
  type IRParam,
  type IRPrim,
  type IRRefBinding,
  type IRStmt,
  type IRType,
  type IRVarDecl,
} from '../ir/nodes';
import {
  isBuiltinConst,
  isContextVar,
  isRuntimeStruct,
  isStdlibClass,
  lookupCTradeMethod,
  lookupFreeIntrinsic,
} from './intrinsics';

export interface LowerOptions {
  /** Module name (usually the source filename stem / #property). */
  name?: string;
}

const EVENT_NAMES: ReadonlySet<string> = new Set<EventName>([
  'OnInit', 'OnDeinit', 'OnTick', 'OnTimer', 'OnTrade',
  'OnStart', 'OnChartEvent', 'OnCalculate', 'OnBookEvent',
]);

const INTEGER_PRIMS: ReadonlySet<IRPrim> = new Set<IRPrim>([
  'int', 'long', 'uint', 'ulong', 'short', 'ushort', 'char', 'uchar', 'handle', 'datetime', 'color',
]);

// ─────────────────────────────────────────────────────────────────────────
// Scope / symbol table
// ─────────────────────────────────────────────────────────────────────────

type SymbolKind = 'input' | 'global' | 'local' | 'param' | 'enumMember' | 'function';

interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  type: IRType;
  /** For enum members: the owning enum name. */
  enumName?: string;
}

class Scope {
  private readonly map = new Map<string, SymbolEntry>();
  constructor(readonly parent?: Scope) {}
  define(entry: SymbolEntry): void {
    this.map.set(entry.name, entry);
  }
  resolve(name: string): SymbolEntry | undefined {
    return this.map.get(name) ?? this.parent?.resolve(name);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Lowering driver
// ─────────────────────────────────────────────────────────────────────────

export function lower(program: Program, opts: LowerOptions = {}): IRModule {
  return new Lowerer(program, opts).run();
}

class Lowerer {
  private readonly globalScope = new Scope();
  private readonly enums = new Map<string, Map<string, number>>(); // enumName → member → value
  private readonly enumMemberToEnum = new Map<string, string>(); // member → enumName
  /** Declared type per object name (for method-call receiver classification). */
  private readonly varTypes = new Map<string, IRType>();
  /** User function declared types (for return-type / async resolution). */
  private readonly userFunctions = new Map<string, FunctionDecl>();
  /** Names of all user-defined functions (for call classification). */
  private readonly userFunctionNames = new Set<string>();
  /** async-ness per user function, computed by fixpoint. */
  private readonly funcAsync = new Map<string, boolean>();
  /** Builtins/constants referenced (for usedBuiltins). */
  private readonly usedBuiltins = new Set<string>();
  /** Struct/class names declared by the user. */
  private readonly userTypes = new Set<string>();
  /** The AST StructDecl for each user class/struct name (for body lowering). */
  private readonly userClassDecls = new Map<string, StructDecl>();
  /** Per-class method-name → FunctionDecl (for receiver method-call resolution). */
  private readonly classMethods = new Map<string, Map<string, FunctionDecl>>();
  /**
   * async-ness per (class, method), keyed `"Class.method"`, computed by the
   * SAME fixpoint as free functions. A method that transitively trades is async.
   */
  private readonly methodAsync = new Map<string, boolean>();
  /**
   * Side-table: each user-class method-call IRCall → the `"OwnerClass.method"`
   * key it dispatches to. Lets the async fixpoint resolve a user-class method
   * call's async-ness against `methodAsync` even though the IRCall's `method`
   * target carries no owning-class field. (Kept off the IR to stay additive.)
   */
  private readonly methodCallKey = new Map<IRCall, string>();

  private readonly inputs: IRInput[] = [];
  private readonly globals: IRGlobal[] = [];
  private readonly functions: IRFunction[] = [];
  private readonly classes: IRClass[] = [];
  private readonly events: Partial<Record<EventName, string>> = {};
  /** Compile-time diagnostics collected while lowering (see ../diagnostics.ts). */
  private readonly diagnostics: Diagnostic[] = [];
  /**
   * Names already reported as unresolved/unknown, to avoid emitting a duplicate
   * diagnostic for every textual occurrence of the same broken reference. (One
   * clear finding per distinct name is the honest, non-noisy report.)
   */
  private readonly reportedNames = new Set<string>();

  constructor(
    private readonly program: Program,
    private readonly opts: LowerOptions,
  ) {}

  run(): IRModule {
    // Carry the parser's own diagnostics (recognised-but-unsupported syntactic
    // constructs it skipped cleanly — operator overloads, out-of-line method
    // definitions) into the module so they surface alongside lowering findings.
    for (const d of this.program.diagnostics ?? []) this.report(d);

    // ── Pass 1: collect top-level declarations (so calls resolve forward) ──
    for (const decl of this.program.decls) {
      this.collectDecl(decl);
    }

    // ── Pass 2: lower bodies (free functions, then user-class methods) ──
    for (const decl of this.program.decls) {
      if (decl.kind === 'FunctionDecl' && decl.body) {
        this.lowerFunction(decl);
      } else if (decl.kind === 'StructDecl' && this.hasClassBody(decl)) {
        this.lowerClass(decl);
      }
    }

    // ── Pass 3: async fixpoint over user functions AND user-class methods ──
    this.computeAsyncFixpoint();
    // Re-apply the converged async-ness onto the emitted IRFunctions + their
    // call sites (a callee may have flipped async after we first lowered it).
    for (const fn of this.functions) {
      const isAsync = this.funcAsync.get(fn.name) ?? fn.isAsync;
      fn.isAsync = isAsync;
      this.applyAsyncToUserCalls(fn.body);
    }
    for (const cls of this.classes) {
      for (const m of cls.methods) {
        const key = `${cls.name}.${m.name}`;
        m.isAsync = this.methodAsync.get(key) ?? m.isAsync;
        this.applyAsyncToUserCalls(m.body);
      }
    }

    return {
      name: this.opts.name ?? this.deriveName(),
      inputs: this.inputs,
      globals: this.globals,
      functions: this.functions,
      classes: this.classes,
      usedBuiltins: [...this.usedBuiltins].sort(),
      events: this.events,
      diagnostics: this.diagnostics,
    };
  }

  /** True if this struct/class decl has a real body (any field or method). */
  private hasClassBody(d: StructDecl): boolean {
    return d.fields.length > 0 || d.methods.length > 0;
  }

  /** Push a diagnostic once per distinct (code, symbol) pair. */
  private report(d: Diagnostic): void {
    const key = `${d.code}:${d.symbol ?? d.message}`;
    if (this.reportedNames.has(key)) return;
    this.reportedNames.add(key);
    this.diagnostics.push(d);
  }

  private deriveName(): string {
    const propName = this.program.properties.find((p) => p.name === 'description')?.value;
    return propName ?? 'Expert';
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pass 1 — collect declarations
  // ───────────────────────────────────────────────────────────────────────

  private collectDecl(decl: Decl): void {
    switch (decl.kind) {
      case 'InputDecl':
        this.collectInput(decl);
        break;
      case 'VarDecl':
        this.collectGlobalVar(decl);
        break;
      case 'FunctionDecl':
        this.collectFunction(decl);
        break;
      case 'EnumDecl':
        this.collectEnum(decl);
        break;
      case 'StructDecl':
        this.collectStruct(decl);
        break;
    }
  }

  private collectInput(d: InputDecl): void {
    const type = this.mapType(d.type);
    this.globalScope.define({ name: d.name, kind: 'input', type });
    this.varTypes.set(d.name, type);
    const init = d.init ? this.foldConst(this.lowerExprBare(d.init)) : undefined;
    this.inputs.push({ name: d.name, type, init, label: d.label });
  }

  private collectGlobalVar(d: VarDecl): void {
    const type = this.mapType(d.type);
    for (const dec of d.declarators) {
      const declType = this.applyArrayType(type, dec.arrayDims.length);
      this.globalScope.define({ name: dec.name, kind: 'global', type: declType });
      this.varTypes.set(dec.name, declType);
      const arrayDims = dec.arrayDims.map((e) => (e ? this.foldConst(this.lowerExprBare(e)) : null));
      let init = dec.init ? this.foldConst(this.lowerExprBare(dec.init)) : undefined;
      // A bare runtime-struct / user-class VALUE decl (`MqlTradeRequest req;`,
      // `MyClass c;`) is default-constructed in MQL5. An object-POINTER
      // (`MyClass *p;`) is null until `new` — leave it to the default.
      if (init === undefined && dec.arrayDims.length === 0 && d.type.pointer === 0) {
        init = this.runtimeStructInit(d.type.name) ?? init;
      }
      this.globals.push({
        name: dec.name,
        type: declType,
        init,
        isConst: d.isConst,
        isStatic: d.isStatic,
        arrayDims,
      });
    }
  }

  /**
   * Synthesize the default construction for a bare (no-init, non-array,
   * non-pointer) declaration of a constructible named type:
   *   - a builtin runtime struct (MqlTradeRequest/MqlTradeResult/…)  →
   *     `new rt.<typeName>()`
   *   - a user-declared class/struct WITH a body (own/inherited methods or
   *     fields)                                                        →
   *     `new <typeName>()`  (a value instance — MQL5 default-constructs it)
   * Returns the `New` IRExpr, or undefined to keep the caller's default-init
   * behaviour (primitives, object-pointers, foreign types). The pointer guard
   * is applied by the caller (an object-pointer `Foo *p;` stays null).
   */
  private runtimeStructInit(typeName: string): IRExpr | undefined {
    if (isRuntimeStruct(typeName)) {
      this.usedBuiltins.add(typeName);
      return { kind: 'New', typeName, args: [], type: { named: typeName, pointer: false } };
    }
    // Standard-Library classes (CTrade, CPositionInfo, CSymbolInfo, CAccountInfo,
    // …) are VALUE objects when declared bare (`CPositionInfo pos;`) — MQL5
    // default-constructs them. The emitter builds `new rt.<Class>(rt)`. This is
    // applied uniformly to globals, locals, AND fields so a bare stdlib-class
    // declaration anywhere constructs the runtime object rather than leaving it
    // `null` (the landmine — a `null` receiver throws on the first method call).
    if (isStdlibClass(typeName)) {
      this.usedBuiltins.add(typeName);
      return { kind: 'New', typeName, args: [], type: { named: typeName, pointer: true } };
    }
    if (this.userClassDecls.has(typeName) && this.hasClassBody(this.userClassDecls.get(typeName)!)) {
      return { kind: 'New', typeName, args: [], type: { named: typeName, pointer: false } };
    }
    return undefined;
  }

  /**
   * Default construction for a bare VALUE field. Now identical to
   * `runtimeStructInit` (which covers runtime structs, Standard-Library classes,
   * AND user classes) — kept as a named alias so the field-lowering call site
   * reads intentionally. Returns the `New` IRExpr, or undefined for primitives /
   * object-pointers / foreign types.
   */
  private fieldConstructionInit(typeName: string): IRExpr | undefined {
    return this.runtimeStructInit(typeName);
  }

  /**
   * Names of free functions that have already been DEFINED (a decl WITH a body).
   * A second definition of the same name is an OVERLOAD — MQL5/C++ permit it via
   * arity/type dispatch, which the transpiler does NOT implement (it would keep
   * only one `function NAME` in the emitted module, silently dropping the rest).
   * We track defined names so a second body is reported LOUDLY (§21), not
   * dropped. A prototype (no body) followed by one definition is NOT an overload.
   */
  private readonly definedFunctionNames = new Set<string>();

  private collectFunction(d: FunctionDecl): void {
    // Detect a second DEFINITION (body) of an already-defined name = overload.
    if (d.body) {
      if (this.definedFunctionNames.has(d.name)) {
        this.report({
          severity: 'error',
          code: 'MQL_UNSUPPORTED_OVERLOAD',
          message:
            `Function '${d.name}' is overloaded (defined more than once). The ` +
            `transpiler does not implement arity/type-based overload dispatch, so ` +
            `only one definition would survive — the others are silently dropped. ` +
            `Rename the overloads to distinct names, or remove the duplicate.`,
          span: d.span,
          symbol: d.name,
        });
      } else {
        this.definedFunctionNames.add(d.name);
      }
    }

    this.userFunctions.set(d.name, d);
    this.userFunctionNames.add(d.name);
    this.globalScope.define({
      name: d.name,
      kind: 'function',
      type: this.mapType(d.returnType),
    });
    // Event handlers seed the async fixpoint as potentially-async (computed later).
    if (EVENT_NAMES.has(d.name)) {
      this.events[d.name as EventName] = d.name;
    }
    // Initialise async as false; the fixpoint raises it.
    if (!this.funcAsync.has(d.name)) this.funcAsync.set(d.name, false);
  }

  private collectEnum(d: EnumDecl): void {
    const members = new Map<string, number>();
    let auto = 0;
    for (const m of d.members) {
      let value = auto;
      if (m.value) {
        const folded = this.foldConst(this.lowerExprBare(m.value));
        if (folded.kind === 'Num') value = folded.value;
      }
      members.set(m.name, value);
      this.enumMemberToEnum.set(m.name, d.name || '<anon>');
      auto = value + 1;
    }
    if (d.name) this.enums.set(d.name, members);
    else this.enums.set('<anon>', members);
    if (d.name) this.userTypes.add(d.name);
  }

  private collectStruct(d: StructDecl): void {
    if (!d.name) return;
    this.userTypes.add(d.name);
    this.userClassDecls.set(d.name, d);

    // Register the class's methods (name → FunctionDecl) so a method call on a
    // receiver of this class type can be resolved + classified. Seed each
    // method's async-ness false; the fixpoint raises it (a method that
    // transitively trades is async, exactly like a free function).
    //
    // Overload detection (§21): two methods of the SAME class sharing a name
    // (each with a body) are an overload — the emitter would keep only the last
    // `NAME(...) { }` method on the TS class, silently dropping the rest. Report
    // it LOUDLY instead. (A ctor + same-named method can't collide — the ctor's
    // name equals the class; two same-named non-ctor methods are the overload.)
    const definedMethodNames = new Set<string>();
    const methods = new Map<string, FunctionDecl>();
    for (const m of d.methods) {
      if (m.body) {
        if (definedMethodNames.has(m.name)) {
          this.report({
            severity: 'error',
            code: 'MQL_UNSUPPORTED_OVERLOAD',
            message:
              `Method '${d.name}::${m.name}' is overloaded (defined more than ` +
              `once in the class). The transpiler does not implement arity/type-` +
              `based overload dispatch, so only one definition would survive — ` +
              `the others are silently dropped. Rename the overloads to distinct ` +
              `names, or remove the duplicate.`,
            span: m.span,
            symbol: `${d.name}.${m.name}`,
          });
        } else {
          definedMethodNames.add(m.name);
        }
      }
      methods.set(m.name, m);
      const key = `${d.name}.${m.name}`;
      if (!this.methodAsync.has(key)) this.methodAsync.set(key, false);
    }
    this.classMethods.set(d.name, methods);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pass 2 — lower function bodies
  // ───────────────────────────────────────────────────────────────────────

  private lowerFunction(d: FunctionDecl): void {
    const scope = new Scope(this.globalScope);
    const params: IRParam[] = [];
    for (const p of d.params) {
      const irParam = this.lowerParam(p, scope);
      params.push(irParam);
    }
    const body = this.lowerBlock(d.body!, scope);
    const returnType = this.mapType(d.returnType);

    // Provisional async-ness from this body's own call sites (raised by fixpoint).
    const localAsync = this.blockHasAsyncCall(body);
    this.funcAsync.set(d.name, localAsync || (this.funcAsync.get(d.name) ?? false));

    const event = EVENT_NAMES.has(d.name) ? (d.name as EventName) : undefined;
    this.functions.push({
      name: d.name,
      returnType,
      params,
      body,
      isAsync: localAsync,
      event,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Pass 2 — lower user-class / struct bodies
  // ───────────────────────────────────────────────────────────────────────

  /**
   * The class currently being lowered. Inside a method body, this lets us:
   *   - resolve a bare `field` / `method()` reference to `this.field` /
   *     `this.method()` (MQL5 allows the implicit `this`),
   *   - classify a `this.method(...)` / receiver-of-this-class method call,
   *   - mark the enclosing method async when it trades (fixpoint key).
   * `undefined` outside any method (free functions, globals).
   */
  private currentClass?: {
    name: string;
    /** field name → field type (own + inherited). */
    fields: Map<string, IRType>;
    /** method names (own + inherited). */
    methods: Set<string>;
  };

  private lowerClass(d: StructDecl): void {
    // Build the member view (own + inherited fields/methods) used to resolve
    // bare/`this`-qualified member references inside the methods.
    const fieldTypes = this.collectClassFieldTypes(d.name);
    const methodNames = this.collectClassMethodNames(d.name);

    const irFields: IRField[] = [];
    for (const fieldDecl of d.fields) {
      const baseType = this.mapType(fieldDecl.type);
      for (const dec of fieldDecl.declarators) {
        const declType = this.applyArrayType(baseType, dec.arrayDims.length);
        const arrayDims = dec.arrayDims.map((e) =>
          e ? this.foldConst(this.lowerExprBare(e)) : null,
        );
        let init = dec.init ? this.foldConst(this.lowerExprBare(dec.init)) : undefined;
        // A bare VALUE field of a constructible type (a stdlib class like
        // `CTrade trade;`, a runtime struct, or a user class) is default-
        // constructed in MQL5 — synthesize the construction. An object-pointer
        // field (`Foo *p;`) stays null. (Mirrors the global/local convention.)
        if (init === undefined && dec.arrayDims.length === 0 && fieldDecl.type.pointer === 0) {
          init = this.fieldConstructionInit(fieldDecl.type.name) ?? init;
        }
        irFields.push({ name: dec.name, type: declType, init, arrayDims });
      }
    }

    const prevClass = this.currentClass;
    this.currentClass = { name: d.name, fields: fieldTypes, methods: methodNames };
    const irMethods: IRMethod[] = [];
    try {
      for (const methodDecl of d.methods) {
        if (!methodDecl.body) continue; // prototype-only method: nothing to emit
        irMethods.push(this.lowerMethod(d.name, methodDecl));
      }
    } finally {
      this.currentClass = prevClass;
    }

    this.classes.push({
      name: d.name,
      keyword: d.keyword,
      base: d.base,
      fields: irFields,
      methods: irMethods,
      templateParams: d.templateParams ?? [],
    });
  }

  private lowerMethod(className: string, d: FunctionDecl): IRMethod {
    const scope = new Scope(this.globalScope);
    const params: IRParam[] = [];
    for (const p of d.params) {
      params.push(this.lowerParam(p, scope));
    }
    const body = this.lowerBlock(d.body!, scope);
    const returnType = this.mapType(d.returnType);

    const isCtor = d.name === className;
    const isDtor = d.name === `~${className}`;

    // Provisional async-ness from this body's own call sites (raised by fixpoint).
    const key = `${className}.${d.name}`;
    const localAsync = this.blockHasAsyncCall(body);
    this.methodAsync.set(key, localAsync || (this.methodAsync.get(key) ?? false));

    return {
      name: d.name,
      returnType,
      params,
      body,
      isAsync: localAsync,
      isCtor,
      isDtor,
    };
  }

  /** Own + inherited field name → type for a user class (single inheritance). */
  private collectClassFieldTypes(className: string): Map<string, IRType> {
    const out = new Map<string, IRType>();
    let cur: string | undefined = className;
    const seen = new Set<string>();
    while (cur && this.userClassDecls.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const d: StructDecl = this.userClassDecls.get(cur)!;
      for (const fieldDecl of d.fields) {
        const baseType = this.mapType(fieldDecl.type);
        for (const dec of fieldDecl.declarators) {
          // A derived field shadows a base one; don't overwrite an own field.
          if (!out.has(dec.name)) {
            out.set(dec.name, this.applyArrayType(baseType, dec.arrayDims.length));
          }
        }
      }
      cur = d.base;
    }
    return out;
  }

  /** Own + inherited method names for a user class (single inheritance). */
  private collectClassMethodNames(className: string): Set<string> {
    const out = new Set<string>();
    let cur: string | undefined = className;
    const seen = new Set<string>();
    while (cur && this.userClassDecls.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const d: StructDecl = this.userClassDecls.get(cur)!;
      for (const m of d.methods) out.add(m.name);
      cur = d.base;
    }
    return out;
  }

  private lowerParam(p: Param, scope: Scope): IRParam {
    const baseType = this.mapType(p.type);
    const isArray = p.arrayDims.length > 0;
    const type = isArray ? this.applyArrayType(baseType, p.arrayDims.length) : baseType;
    scope.define({ name: p.name, kind: 'param', type });
    if (p.name) this.varTypes.set(p.name, type);
    const byRef = isArray || p.type.isRef;
    const defaultValue = p.defaultValue
      ? this.foldConst(this.lowerExpr(p.defaultValue, scope))
      : undefined;
    return { name: p.name, type, isArray, byRef, defaultValue };
  }

  private lowerBlock(block: Block, parent: Scope): IRBlock {
    const scope = new Scope(parent);
    const body: IRStmt[] = [];
    for (const stmt of block.statements) {
      const lowered = this.lowerStmt(stmt, scope);
      if (lowered) body.push(lowered);
    }
    return { kind: 'Block', body };
  }

  private lowerStmt(stmt: Stmt, scope: Scope): IRStmt | null {
    switch (stmt.kind) {
      case 'Block':
        return this.lowerBlock(stmt, scope);
      case 'VarDecl':
        return this.lowerLocalVarDecl(stmt, scope);
      case 'ExprStmt':
        return { kind: 'ExprStmt', expr: this.lowerExpr(stmt.expr, scope) };
      case 'IfStmt': {
        const cond = this.lowerExpr(stmt.cond, scope);
        const then = this.lowerStmtNonNull(stmt.then, scope);
        const els = stmt.else ? this.lowerStmtNonNull(stmt.else, scope) : undefined;
        return { kind: 'If', cond, then, else: els };
      }
      case 'ForStmt': {
        const forScope = new Scope(scope);
        let init: IRFor['init'];
        if (stmt.init) {
          if (stmt.init.kind === 'VarDecl') {
            const lowered = this.lowerLocalVarDecl(stmt.init, forScope);
            // IRFor.init accepts only IRVarDecl | IRExprStmt. A single-declarator
            // init lowers to a bare IRVarDecl; a multi-declarator
            // `for(int i=0, n=...;;)` lowers to a Block of IRVarDecls — the IR
            // can't hold that in `init`, so we take the first declarator as the
            // loop init (single-declarator inits are the norm and the PoC path).
            init =
              lowered.kind === 'Block'
                ? (lowered.body[0] as IRVarDecl)
                : (lowered as IRVarDecl);
          } else {
            init = { kind: 'ExprStmt', expr: this.lowerExpr(stmt.init.expr, forScope) };
          }
        }
        const cond = stmt.cond ? this.lowerExpr(stmt.cond, forScope) : undefined;
        const update = stmt.update ? this.lowerExpr(stmt.update, forScope) : undefined;
        const body = this.lowerStmtNonNull(stmt.body, forScope);
        return { kind: 'For', init, cond, update, body };
      }
      case 'WhileStmt':
        return {
          kind: 'While',
          cond: this.lowerExpr(stmt.cond, scope),
          body: this.lowerStmtNonNull(stmt.body, scope),
        };
      case 'DoWhileStmt':
        return {
          kind: 'DoWhile',
          body: this.lowerStmtNonNull(stmt.body, scope),
          cond: this.lowerExpr(stmt.cond, scope),
        };
      case 'ReturnStmt':
        return { kind: 'Return', value: stmt.value ? this.lowerExpr(stmt.value, scope) : undefined };
      case 'BreakStmt':
        return { kind: 'Break' };
      case 'ContinueStmt':
        return { kind: 'Continue' };
      case 'SwitchStmt': {
        const disc = this.lowerExpr(stmt.disc, scope);
        const cases = stmt.cases.map((c) => {
          const caseScope = new Scope(scope);
          return {
            test: c.test ? this.lowerExpr(c.test, caseScope) : undefined,
            body: c.body
              .map((s) => this.lowerStmt(s, caseScope))
              .filter((s): s is IRStmt => s !== null),
          };
        });
        return { kind: 'Switch', disc, cases };
      }
      case 'EmptyStmt':
        return null;
    }
  }

  private lowerStmtNonNull(stmt: Stmt, scope: Scope): IRStmt {
    const lowered = this.lowerStmt(stmt, scope);
    return lowered ?? { kind: 'Block', body: [] };
  }

  private lowerLocalVarDecl(d: VarDecl, scope: Scope): IRStmt {
    const baseType = this.mapType(d.type);
    // A VarDecl with multiple declarators lowers to a Block of single VarDecls
    // (the IR's IRVarDecl is single-name). One declarator → a bare IRVarDecl.
    const irDecls: IRStmt[] = [];
    for (const dec of d.declarators) {
      const declType = this.applyArrayType(baseType, dec.arrayDims.length);
      scope.define({ name: dec.name, kind: 'local', type: declType });
      this.varTypes.set(dec.name, declType);
      const arrayDims = dec.arrayDims.map((e) => (e ? this.foldConst(this.lowerExpr(e, scope)) : null));
      let init = dec.init ? this.lowerExpr(dec.init, scope) : undefined;
      // A bare runtime-struct / user-class VALUE local is default-constructed.
      // An object-POINTER (`MyClass *p;`) stays null until `new`.
      if (init === undefined && dec.arrayDims.length === 0 && d.type.pointer === 0) {
        init = this.runtimeStructInit(d.type.name) ?? init;
      }
      irDecls.push({
        kind: 'VarDecl',
        name: dec.name,
        type: declType,
        init,
        arrayDims,
        isConst: d.isConst,
      });
    }
    if (irDecls.length === 1) return irDecls[0];
    return { kind: 'Block', body: irDecls };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Expressions
  // ───────────────────────────────────────────────────────────────────────

  /** Lower an expression with no scope (top-level inits / array dims / enum vals). */
  private lowerExprBare(e: Expr): IRExpr {
    return this.lowerExpr(e, this.globalScope);
  }

  private lowerExpr(e: Expr, scope: Scope): IRExpr {
    switch (e.kind) {
      case 'NumberLit':
        return {
          kind: 'Num',
          value: e.value,
          isFloat: e.isFloat,
          type: e.isFloat ? T.double : T.int,
        };
      case 'StringLit':
        return { kind: 'Str', value: e.value, type: T.string };
      case 'BoolLit':
        return { kind: 'Bool', value: e.value, type: T.bool };
      case 'CharLit':
        return { kind: 'Num', value: e.value, isFloat: false, type: { prim: 'char' } };
      case 'Identifier':
        return this.lowerIdentifier(e.name, scope, e.span);
      case 'ScopeResolution':
        return this.lowerScopeResolution(e.scope, e.name);
      case 'MemberAccess':
        return this.lowerMember(e, scope);
      case 'IndexExpr': {
        const array = this.lowerExpr(e.array, scope);
        const index = this.lowerExpr(e.index, scope);
        return { kind: 'Index', array, index, type: this.elementType(this.exprType(array)) };
      }
      case 'CallExpr':
        return this.lowerCall(e, scope);
      case 'NewExpr': {
        const args = e.args.map((a) => this.lowerExpr(a, scope));
        if (isStdlibClass(e.type.name)) this.usedBuiltins.add(e.type.name);
        return {
          kind: 'New',
          typeName: e.type.name,
          args,
          type: { named: e.type.name, pointer: true },
        };
      }
      case 'DeleteExpr': {
        // The IR has no `delete` expression node (IRDelete is not part of IRExpr).
        // MQL5 `delete p` is an object-pointer free; we lower it to a host
        // intrinsic call `__delete(p)` so it fits the IRExpr union and the
        // runtime can implement deletion semantics. (No async, no value.)
        const operand = this.lowerExpr(e.operand, scope);
        const info = { provider: 'host' as const, name: '__delete', isAsync: false };
        this.usedBuiltins.add('__delete');
        return this.makeCall({ kind: 'intrinsic', info }, [operand], false, T.void);
      }
      case 'UnaryExpr': {
        const operand = this.lowerExpr(e.operand, scope);
        const type = e.op === '!' ? T.bool : this.exprType(operand);
        return { kind: 'Unary', op: e.op, operand, prefix: e.prefix, type };
      }
      case 'BinaryExpr':
        return this.lowerBinary(e, scope);
      case 'AssignExpr':
        return this.lowerAssign(e, scope);
      case 'TernaryExpr': {
        const cond = this.lowerExpr(e.cond, scope);
        const then = this.lowerExpr(e.then, scope);
        const els = this.lowerExpr(e.else, scope);
        return {
          kind: 'Ternary',
          cond,
          then,
          else: els,
          type: this.unifyType(this.exprType(then), this.exprType(els)),
        };
      }
      case 'CastExpr': {
        const to = this.mapType(e.type);
        return { kind: 'Cast', to, expr: this.lowerExpr(e.expr, scope), type: to };
      }
    }
  }

  private lowerIdentifier(name: string, scope: Scope, span?: Span): IRExpr {
    // 0. `this` inside a user-class method → the bare `this` receiver.
    if (name === 'this') {
      const t: IRType = this.currentClass
        ? { named: this.currentClass.name, pointer: true }
        : T.unknown;
      return { kind: 'Ref', binding: { kind: 'thisRef' }, type: t };
    }
    // 1. context vars (_Symbol, _Period, ...)
    if (isContextVar(name)) {
      this.usedBuiltins.add(name);
      return { kind: 'Ref', binding: { kind: 'contextVar', name }, type: this.contextVarType(name) };
    }
    // 2. lexical scope (input/global/local/param/function)
    const sym = scope.resolve(name);
    if (sym) {
      const binding = this.symbolToBinding(sym);
      return { kind: 'Ref', binding, type: sym.type };
    }
    // 2b. implicit `this`: a bare member of the current class (field or method
    //     used without an explicit `this.`). MQL5 allows it; resolve to a
    //     `this.NAME` member so the emitter produces `this.x` / `this.calc()`.
    if (this.currentClass) {
      const fieldType = this.currentClass.fields.get(name);
      if (fieldType !== undefined) {
        return this.makeThisMember(name, fieldType);
      }
      if (this.currentClass.methods.has(name)) {
        // A bare method reference (only meaningful when immediately called).
        // Lower to `this.NAME` member; lowerCall classifies the surrounding call.
        return this.makeThisMember(name, T.unknown);
      }
    }
    // 3. enum member (unqualified)
    if (this.enumMemberToEnum.has(name)) {
      const enumName = this.enumMemberToEnum.get(name)!;
      return {
        kind: 'Ref',
        binding: { kind: 'enumMember', enumName, name },
        type: { named: enumName },
      };
    }
    // 4. builtin constant (MODE_SMA, INVALID_HANDLE, ...)
    if (isBuiltinConst(name)) {
      this.usedBuiltins.add(name);
      return { kind: 'Ref', binding: { kind: 'builtinConst', name }, type: this.constType(name) };
    }
    // 5. unresolved — emit a real diagnostic (§21: report the gap, don't fake a
    //    value). We still lower it to a bare `global` ref so emission produces
    //    `name` and downstream passes don't crash, but the diagnostic makes the
    //    landmine LOUD: this name would be `undefined` at run time. The CLIs
    //    treat MQL_UNRESOLVED_NAME as fatal (non-zero exit on transpile).
    this.report({
      severity: 'error',
      code: 'MQL_UNRESOLVED_NAME',
      message:
        `Unresolved name '${name}': it is not an input, global, local, ` +
        `parameter, enum member, context variable, or known builtin constant. ` +
        `It would be undefined at run time.`,
      span,
      symbol: name,
    });
    return { kind: 'Ref', binding: { kind: 'global', name }, type: T.unknown };
  }

  private symbolToBinding(sym: SymbolEntry): IRRefBinding {
    switch (sym.kind) {
      case 'input':
        return { kind: 'input', name: sym.name };
      case 'global':
      case 'function':
        return { kind: 'global', name: sym.name };
      case 'local':
        return { kind: 'local', name: sym.name };
      case 'param':
        return { kind: 'param', name: sym.name };
      case 'enumMember':
        return { kind: 'enumMember', enumName: sym.enumName ?? '<anon>', name: sym.name };
    }
  }

  private lowerScopeResolution(scopeName: string, name: string): IRExpr {
    // Enum-qualified member `EnumName::MEMBER`.
    const enumMembers = this.enums.get(scopeName);
    if (enumMembers && enumMembers.has(name)) {
      return {
        kind: 'Ref',
        binding: { kind: 'enumMember', enumName: scopeName, name },
        type: { named: scopeName },
      };
    }
    // builtin const reached via scope (rare) — fall back to builtinConst by name.
    if (isBuiltinConst(name)) {
      this.usedBuiltins.add(name);
      return { kind: 'Ref', binding: { kind: 'builtinConst', name }, type: this.constType(name) };
    }
    // Unknown scope::name — represent as a builtinConst reference by joined name
    // is wrong; instead emit an enumMember-style ref so the emitter can qualify.
    return {
      kind: 'Ref',
      binding: { kind: 'enumMember', enumName: scopeName, name },
      type: T.unknown,
    };
  }

  private lowerMember(e: MemberAccess, scope: Scope): IRExpr {
    const object = this.lowerExpr(e.object, scope);
    // If the object is a user-class instance, give the member its declared field
    // type (so e.g. `obj.x` in arithmetic classifies correctly). Otherwise leave
    // it `unknown` (the emitter prints `obj.member` regardless).
    const memberType = this.memberFieldType(object, e.member);
    return { kind: 'Member', object, member: e.member, type: memberType };
  }

  /** `this.NAME` member ref for an implicit-this field/method reference. */
  private makeThisMember(name: string, type: IRType): IRExpr {
    const thisType: IRType = this.currentClass
      ? { named: this.currentClass.name, pointer: true }
      : T.unknown;
    const object: IRExpr = { kind: 'Ref', binding: { kind: 'thisRef' }, type: thisType };
    return { kind: 'Member', object, member: name, type };
  }

  /** Declared type of `object.member` when `object` is a known user-class. */
  private memberFieldType(object: IRExpr, member: string): IRType {
    const typeName = this.exprTypeName(object);
    if (typeName && this.userClassDecls.has(typeName)) {
      const fields = this.collectClassFieldTypes(typeName);
      const ft = fields.get(member);
      if (ft !== undefined) return ft;
    }
    return T.unknown;
  }

  /** The named type of an expression's value (class/struct name), if known. */
  private exprTypeName(e: IRExpr): string | undefined {
    const t = this.exprType(e);
    return t.named;
  }

  private lowerBinary(e: BinaryExpr, scope: Scope): IRExpr {
    const left = this.lowerExpr(e.left, scope);
    const right = this.lowerExpr(e.right, scope);
    const lt = this.exprType(left);
    const rt = this.exprType(right);
    const isDivMod = e.op === '/' || e.op === '%';
    const bothInt = this.isIntegerType(lt) && this.isIntegerType(rt);
    const intArith = isDivMod && bothInt;
    const type = this.binaryResultType(e.op, lt, rt);
    return { kind: 'Binary', op: e.op, left, right, intArith, type };
  }

  private lowerAssign(e: AssignExpr, scope: Scope): IRExpr {
    const target = this.lowerExpr(e.target, scope);
    const value = this.lowerExpr(e.value, scope);
    return { kind: 'Assign', op: e.op, target, value, type: this.exprType(target) };
  }

  private lowerCall(e: CallExpr, scope: Scope): IRExpr {
    const args = e.args.map((a) => this.lowerExpr(a, scope));

    // ── free function call: callee is a bare Identifier ──
    if (e.callee.kind === 'Identifier') {
      const fname = e.callee.name;

      // user function?
      if (this.userFunctionNames.has(fname)) {
        const target: IRCallTarget = { kind: 'user', name: fname };
        const isAsync = this.funcAsync.get(fname) ?? false;
        return this.makeCall(target, args, isAsync, this.userReturnType(fname));
      }

      // implicit-`this` method call inside a user-class method: a bare
      // `method(args)` where `method` is own-or-inherited on the current class
      // → `this.method(args)` (MQL5 allows the implicit `this`). Lowered as a
      // user-class method call so it joins the async fixpoint.
      if (this.currentClass && this.currentClass.methods.has(fname)) {
        const owner = this.findMethodOwner(this.currentClass.name, fname);
        if (owner) {
          const key = `${owner.className}.${fname}`;
          const isAsync = this.methodAsync.get(key) ?? false;
          const receiver: IRExpr = {
            kind: 'Ref',
            binding: { kind: 'thisRef' },
            type: { named: this.currentClass.name, pointer: true },
          };
          const target: IRCallTarget = { kind: 'method', receiver, method: fname, info: undefined };
          const call = this.makeCall(target, args, isAsync, this.mapType(owner.decl.returnType));
          this.methodCallKey.set(call, key);
          return call;
        }
      }

      // intrinsic free function?
      const info = lookupFreeIntrinsic(fname);
      if (info) {
        this.usedBuiltins.add(info.name);
        const target: IRCallTarget = { kind: 'intrinsic', info };
        return this.makeCall(target, args, info.isAsync, this.intrinsicReturnType(fname));
      }

      // sizeof pseudo-intrinsic (host, sync) — produced by the parser.
      if (fname === 'sizeof') {
        const info2 = { provider: 'host' as const, name: 'sizeof', isAsync: false };
        return this.makeCall({ kind: 'intrinsic', info: info2 }, args, false, T.int);
      }

      // unknown free call — neither a user function nor a recognised builtin
      // (and not the sizeof/delete pseudo-intrinsics handled above). Emit a
      // real diagnostic (§21): this call would throw `TypeError: fname is not a
      // function` at run time. We still lower it to a `user`-call shape so
      // emission produces `fname(args)` and downstream passes don't crash, but
      // the diagnostic makes the gap LOUD. The CLIs treat MQL_UNKNOWN_CALL as
      // fatal (non-zero exit on transpile).
      this.report({
        severity: 'error',
        code: 'MQL_UNKNOWN_CALL',
        message:
          `Unknown call '${fname}(...)': '${fname}' is neither a user-defined ` +
          `function nor a recognised MQL5 builtin. It would throw at run time.`,
        span: e.callee.span,
        symbol: fname,
      });
      const target: IRCallTarget = { kind: 'user', name: fname };
      return this.makeCall(target, args, false, T.unknown);
    }

    // ── method call: callee is a MemberAccess obj.method ──
    if (e.callee.kind === 'MemberAccess') {
      const member = e.callee.member;
      const receiver = this.lowerExpr(e.callee.object, scope);
      const receiverTypeName =
        this.receiverTypeName(e.callee.object, scope) ?? this.exprTypeName(receiver);

      let info: ReturnType<typeof lookupCTradeMethod> | undefined;
      if (receiverTypeName && isStdlibClass(receiverTypeName)) {
        // For CTrade, look up the method's async/provider classification.
        if (receiverTypeName === 'CTrade') {
          info = lookupCTradeMethod(member);
          if (info) {
            this.usedBuiltins.add(`${receiverTypeName}.${member}`);
          } else {
            // Recognised stdlib class, UNRECOGNISED method: the runtime object
            // has no such method, so it would throw at run time. Be loud (§21).
            // (Methods on USER struct/class receivers are NOT flagged here —
            // only the known-stdlib surface, whose method set we know exactly.)
            this.report({
              severity: 'error',
              code: 'MQL_UNKNOWN_METHOD',
              message:
                `Unknown method '${receiverTypeName}.${member}(...)': not a ` +
                `recognised ${receiverTypeName} method. It would throw at run time.`,
              span: e.callee.span,
              symbol: `${receiverTypeName}.${member}`,
            });
          }
        }
        const isAsync = info?.isAsync ?? false;
        const target: IRCallTarget = { kind: 'method', receiver, method: member, info };
        return this.makeCall(target, args, isAsync, info ? this.ctradeReturnType(member) : T.unknown);
      }

      // ── user-class method call (obj.method / this.method) ──
      // Resolve through single inheritance; async-ness comes from the same
      // fixpoint as free functions (a method that transitively trades is async).
      if (receiverTypeName && this.userClassDecls.has(receiverTypeName)) {
        const owner = this.findMethodOwner(receiverTypeName, member);
        if (owner) {
          const key = `${owner.className}.${member}`;
          const isAsync = this.methodAsync.get(key) ?? false;
          const target: IRCallTarget = { kind: 'method', receiver, method: member, info: undefined };
          const call = this.makeCall(target, args, isAsync, this.mapType(owner.decl.returnType));
          this.methodCallKey.set(call, key);
          return call;
        }
        // Unknown method on a known user class: be loud (§21) — it would throw.
        this.report({
          severity: 'error',
          code: 'MQL_UNKNOWN_METHOD',
          message:
            `Unknown method '${receiverTypeName}.${member}(...)': '${receiverTypeName}' ` +
            `has no such method (own or inherited). It would throw at run time.`,
          span: e.callee.span,
          symbol: `${receiverTypeName}.${member}`,
        });
        const target: IRCallTarget = { kind: 'method', receiver, method: member, info: undefined };
        return this.makeCall(target, args, false, T.unknown);
      }

      // ── method on an unknown/runtime-struct/foreign receiver ──
      // We don't know the receiver's method set (a runtime struct, a forwarded
      // value, a template type param), so we emit the call verbatim and stay
      // SYNC. (Trading paths go through CTrade or the OrderSend intrinsic, both
      // classified above/as free intrinsics — so an unclassified method call is
      // never a missed-await on the trade path.)
      const target: IRCallTarget = { kind: 'method', receiver, method: member, info: undefined };
      return this.makeCall(target, args, false, T.unknown);
    }

    // ── any other callee shape (e.g. (expr)(...) or A::b(...)) ──
    if (e.callee.kind === 'ScopeResolution') {
      // Treat as a user call to the scoped name (best-effort).
      const target: IRCallTarget = { kind: 'user', name: `${e.callee.scope}::${e.callee.name}` };
      return this.makeCall(target, args, false, T.unknown);
    }

    // fallback: lower the callee as an expression and wrap as a user call by
    // synthesising — but the IR has no "call an arbitrary expr" target, so we
    // represent it as a method on the lowered callee with an empty method name.
    const receiver = this.lowerExpr(e.callee, scope);
    const target: IRCallTarget = { kind: 'method', receiver, method: '', info: undefined };
    return this.makeCall(target, args, false, T.unknown);
  }

  private makeCall(target: IRCallTarget, args: IRExpr[], isAsync: boolean, type: IRType): IRCall {
    return { kind: 'Call', target, args, isAsync, type };
  }

  /** Determine the declared stdlib/user type name of a method-call receiver. */
  private receiverTypeName(objExpr: Expr, scope: Scope): string | undefined {
    if (objExpr.kind === 'Identifier') {
      // `this` inside a method → the enclosing class.
      if (objExpr.name === 'this') return this.currentClass?.name;
      const sym = scope.resolve(objExpr.name);
      const type = sym?.type ?? this.varTypes.get(objExpr.name);
      if (type) return this.typeName(type);
    }
    // new CTrade()/chained member — try lowering and reading the type name
    // (handled by the caller via exprTypeName on the lowered receiver).
    return undefined;
  }

  /**
   * Walk the single-inheritance chain from `className` to find the class that
   * declares `method`; returns {className, decl} or undefined.
   */
  private findMethodOwner(
    className: string,
    method: string,
  ): { className: string; decl: FunctionDecl } | undefined {
    let cur: string | undefined = className;
    const seen = new Set<string>();
    while (cur && this.userClassDecls.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const m = this.classMethods.get(cur)?.get(method);
      if (m) return { className: cur, decl: m };
      cur = this.userClassDecls.get(cur)!.base;
    }
    return undefined;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Async fixpoint
  // ───────────────────────────────────────────────────────────────────────

  /**
   * A user function is async iff its body transitively contains an async call:
   * an intrinsic-async call, an async CTrade method, OR a call to a user
   * function that is (transitively) async. Iterate to a fixed point.
   */
  private computeAsyncFixpoint(): void {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 10_000) {
      changed = false;
      for (const fn of this.functions) {
        if (this.funcAsync.get(fn.name)) continue; // already async
        if (this.blockReferencesAsyncCallee(fn.body)) {
          this.funcAsync.set(fn.name, true);
          changed = true;
        }
      }
      // User-class methods participate in the SAME fixpoint: a method becomes
      // async if its body references an async callee (intrinsic-async, an async
      // free function, or an async sibling/own method).
      for (const cls of this.classes) {
        for (const m of cls.methods) {
          const key = `${cls.name}.${m.name}`;
          if (this.methodAsync.get(key)) continue; // already async
          if (this.blockReferencesAsyncCallee(m.body)) {
            this.methodAsync.set(key, true);
            changed = true;
          }
        }
      }
    }
  }

  /** True if the block contains a call that is async OR targets an async user fn. */
  private blockReferencesAsyncCallee(block: IRBlock): boolean {
    return this.someCallInBlock(block, (call) => this.callIsAsyncNow(call));
  }

  private callIsAsyncNow(call: IRCall): boolean {
    if (call.isAsync) return true;
    if (call.target.kind === 'user') {
      return this.funcAsync.get(call.target.name) ?? false;
    }
    // A user-class method call: resolve its async-ness against the live
    // methodAsync map (the IRCall→key side-table records the owning method).
    const key = this.methodCallKey.get(call);
    if (key !== undefined) {
      return this.methodAsync.get(key) ?? false;
    }
    return false;
  }

  /** After the fixpoint, propagate converged async-ness onto user-call sites. */
  private applyAsyncToUserCalls(block: IRBlock): void {
    this.forEachCallInBlock(block, (call) => {
      if (call.target.kind === 'user') {
        const a = this.funcAsync.get(call.target.name);
        if (a) call.isAsync = true;
        return;
      }
      // User-class method calls: pick up the converged method async-ness.
      const key = this.methodCallKey.get(call);
      if (key !== undefined && this.methodAsync.get(key)) {
        call.isAsync = true;
      }
    });
  }

  private blockHasAsyncCall(block: IRBlock): boolean {
    return this.someCallInBlock(block, (call) => call.isAsync);
  }

  // ── IR walkers (call sites only — enough for the async analysis) ──

  private someCallInBlock(block: IRBlock, pred: (c: IRCall) => boolean): boolean {
    let found = false;
    this.forEachCallInBlock(block, (c) => {
      if (!found && pred(c)) found = true;
    });
    return found;
  }

  private forEachCallInBlock(block: IRBlock, fn: (c: IRCall) => void): void {
    for (const s of block.body) this.forEachCallInStmt(s, fn);
  }

  private forEachCallInStmt(s: IRStmt, fn: (c: IRCall) => void): void {
    switch (s.kind) {
      case 'Block':
        this.forEachCallInBlock(s, fn);
        break;
      case 'VarDecl':
        if (s.init) this.forEachCallInExpr(s.init, fn);
        for (const d of s.arrayDims) if (d) this.forEachCallInExpr(d, fn);
        break;
      case 'ExprStmt':
        this.forEachCallInExpr(s.expr, fn);
        break;
      case 'If':
        this.forEachCallInExpr(s.cond, fn);
        this.forEachCallInStmt(s.then, fn);
        if (s.else) this.forEachCallInStmt(s.else, fn);
        break;
      case 'For':
        if (s.init) this.forEachCallInStmt(s.init, fn);
        if (s.cond) this.forEachCallInExpr(s.cond, fn);
        if (s.update) this.forEachCallInExpr(s.update, fn);
        this.forEachCallInStmt(s.body, fn);
        break;
      case 'While':
        this.forEachCallInExpr(s.cond, fn);
        this.forEachCallInStmt(s.body, fn);
        break;
      case 'DoWhile':
        this.forEachCallInStmt(s.body, fn);
        this.forEachCallInExpr(s.cond, fn);
        break;
      case 'Return':
        if (s.value) this.forEachCallInExpr(s.value, fn);
        break;
      case 'Switch':
        this.forEachCallInExpr(s.disc, fn);
        for (const c of s.cases) {
          if (c.test) this.forEachCallInExpr(c.test, fn);
          for (const bs of c.body) this.forEachCallInStmt(bs, fn);
        }
        break;
      case 'Break':
      case 'Continue':
        break;
    }
  }

  private forEachCallInExpr(e: IRExpr, fn: (c: IRCall) => void): void {
    switch (e.kind) {
      case 'Call':
        for (const a of e.args) this.forEachCallInExpr(a, fn);
        if (e.target.kind === 'method') this.forEachCallInExpr(e.target.receiver, fn);
        fn(e);
        break;
      case 'Member':
        this.forEachCallInExpr(e.object, fn);
        break;
      case 'Index':
        this.forEachCallInExpr(e.array, fn);
        this.forEachCallInExpr(e.index, fn);
        break;
      case 'New':
        for (const a of e.args) this.forEachCallInExpr(a, fn);
        break;
      case 'Unary':
        this.forEachCallInExpr(e.operand, fn);
        break;
      case 'Binary':
        this.forEachCallInExpr(e.left, fn);
        this.forEachCallInExpr(e.right, fn);
        break;
      case 'Assign':
        this.forEachCallInExpr(e.target, fn);
        this.forEachCallInExpr(e.value, fn);
        break;
      case 'Ternary':
        this.forEachCallInExpr(e.cond, fn);
        this.forEachCallInExpr(e.then, fn);
        this.forEachCallInExpr(e.else, fn);
        break;
      case 'Cast':
        this.forEachCallInExpr(e.expr, fn);
        break;
      case 'Num':
      case 'Str':
      case 'Bool':
      case 'Ref':
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Type mapping & helpers
  // ───────────────────────────────────────────────────────────────────────

  private mapType(t: TypeRef): IRType {
    const prim = mqlPrim(t.name);
    let base: IRType;
    if (prim) {
      base = { prim };
    } else if (this.enums.has(t.name)) {
      base = { named: t.name };
    } else {
      base = { named: t.name };
    }
    if (t.pointer > 0) return { ...base, pointer: true };
    return base;
  }

  private applyArrayType(elem: IRType, dims: number): IRType {
    let type = elem;
    for (let k = 0; k < dims; k++) type = { arrayOf: type };
    return type;
  }

  private elementType(t: IRType): IRType {
    return t.arrayOf ?? T.unknown;
  }

  /**
   * Read the IRType of an IRExpr. NOTE: the frozen IR contract lists `IRDelete`
   * as a member of the `IRExpr` union (ir/nodes.ts line 204) but `IRDelete` has
   * NO `type` field — so a direct `expr.type` does not typecheck. We never
   * actually produce an `IRDelete` (we lower `delete` to a `__delete` intrinsic
   * call which DOES carry a type), so this accessor is total in practice; it
   * returns `unknown` for the contract's type-less node. (Reported as a contract
   * issue — the frozen file is not edited.)
   */
  private exprType(e: IRExpr): IRType {
    return 'type' in e ? e.type : T.unknown;
  }

  private typeName(t: IRType): string | undefined {
    if (t.named) return t.named;
    if (t.prim) return t.prim;
    return undefined;
  }

  private isIntegerType(t: IRType): boolean {
    return t.prim !== undefined && INTEGER_PRIMS.has(t.prim);
  }

  private binaryResultType(op: string, l: IRType, r: IRType): IRType {
    // Comparisons / logical → bool.
    if (['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(op)) return T.bool;
    // string concatenation
    if (op === '+' && (l.prim === 'string' || r.prim === 'string')) return T.string;
    // double dominates int
    if (l.prim === 'double' || r.prim === 'double' || l.prim === 'float' || r.prim === 'float') {
      return T.double;
    }
    if (this.isIntegerType(l) && this.isIntegerType(r)) return l.prim ? { prim: l.prim } : T.int;
    return l.prim || l.named ? l : r;
  }

  private unifyType(a: IRType, b: IRType): IRType {
    if (a.prim === 'double' || b.prim === 'double') return T.double;
    if (a.prim && b.prim && a.prim === b.prim) return { prim: a.prim };
    return a.prim || a.named ? a : b;
  }

  private contextVarType(name: string): IRType {
    switch (name) {
      case '_Symbol':
        return T.string;
      case '_Period':
        return { prim: 'int' };
      case '_Digits':
        return { prim: 'int' };
      case '_Point':
        return T.double;
      case '_LastError':
      case '_RandomSeed':
      case '_UninitReason':
        return { prim: 'int' };
      case '_StopFlag':
        return T.bool;
      default:
        return T.unknown;
    }
  }

  private constType(name: string): IRType {
    // INVALID_HANDLE / retcodes / enum selectors are integers; EMPTY_VALUE double.
    if (name === 'EMPTY_VALUE') return T.double;
    return { prim: 'int' };
  }

  private userReturnType(name: string): IRType {
    const fn = this.userFunctions.get(name);
    return fn ? this.mapType(fn.returnType) : T.unknown;
  }

  private intrinsicReturnType(name: string): IRType {
    // The handful with well-known shapes; default unknown (emitter doesn't need it).
    switch (name) {
      case 'iMA':
      case 'iRSI':
      case 'iATR':
      case 'iMACD':
      case 'iBands':
      case 'iStochastic':
      case 'iADX':
      case 'iCustom':
        return T.handle;
      case 'CopyBuffer':
      case 'CopyClose':
      case 'CopyOpen':
      case 'CopyHigh':
      case 'CopyLow':
      case 'CopyTime':
      case 'Bars':
      case 'PositionsTotal':
      case 'OrdersTotal':
      case 'ArraySize':
      case 'ArrayResize':
      case 'GetLastError':
        return { prim: 'int' };
      case 'iClose':
      case 'iOpen':
      case 'iHigh':
      case 'iLow':
      case 'NormalizeDouble':
      case 'AccountInfoDouble':
      case 'SymbolInfoDouble':
      case 'PositionGetDouble':
        return T.double;
      case 'PositionSelect':
      case 'PositionSelectByTicket':
      case 'ArraySetAsSeries':
      case 'ArrayGetAsSeries':
      case 'IndicatorRelease':
      case 'SymbolInfoTick':
        return T.bool;
      case 'PositionGetSymbol':
      case 'AccountInfoString':
      case 'PositionGetString':
        return T.string;
      case 'TimeCurrent':
      case 'TimeLocal':
      case 'iTime':
        return { prim: 'datetime' };
      default:
        return T.unknown;
    }
  }

  private ctradeReturnType(method: string): IRType {
    // Trade ops return bool; result accessors vary.
    if (['Buy', 'Sell', 'PositionClose', 'PositionModify', 'PositionOpen'].includes(method)) {
      return T.bool;
    }
    if (['ResultRetcode', 'ResultDeal', 'ResultOrder'].includes(method)) return { prim: 'int' };
    if (['ResultVolume', 'ResultPrice', 'ResultBid', 'ResultAsk'].includes(method)) return T.double;
    if (['ResultRetcodeDescription', 'ResultComment'].includes(method)) return T.string;
    return T.void;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Constant folding (trivial)
  // ───────────────────────────────────────────────────────────────────────

  /** Fold trivially-constant expressions: numeric unary/binary on Num literals. */
  private foldConst(e: IRExpr): IRExpr {
    if (e.kind === 'Unary' && e.operand.kind === 'Num') {
      const v = e.operand.value;
      switch (e.op) {
        case '-':
          return { kind: 'Num', value: -v, isFloat: e.operand.isFloat, type: e.operand.type };
        case '+':
          return e.operand;
        case '!':
          return { kind: 'Bool', value: !v, type: T.bool };
        case '~':
          return { kind: 'Num', value: ~v, isFloat: false, type: { prim: 'int' } };
      }
    }
    if (e.kind === 'Binary' && e.left.kind === 'Num' && e.right.kind === 'Num') {
      const a = e.left.value;
      const b = e.right.value;
      const isFloat = e.left.isFloat || e.right.isFloat;
      const num = (value: number, f = isFloat): IRExpr => ({
        kind: 'Num',
        value,
        isFloat: f,
        type: f ? T.double : T.int,
      });
      switch (e.op) {
        case '+':
          return num(a + b);
        case '-':
          return num(a - b);
        case '*':
          return num(a * b);
        case '/':
          if (b === 0) return e; // don't fold a div-by-zero
          return e.intArith ? num(Math.trunc(a / b), false) : num(a / b, true);
        case '%':
          if (b === 0) return e;
          return num(a % b, false);
        case '<<':
          return num(a << b, false);
        case '>>':
          return num(a >> b, false);
        case '&':
          return num(a & b, false);
        case '|':
          return num(a | b, false);
        case '^':
          return num(a ^ b, false);
      }
    }
    return e;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MQL5 primitive type mapping
// ─────────────────────────────────────────────────────────────────────────

function mqlPrim(name: string): IRPrim | undefined {
  switch (name) {
    case 'int':
      return 'int';
    case 'long':
      return 'long';
    case 'uint':
      return 'uint';
    case 'ulong':
      return 'ulong';
    case 'short':
      return 'short';
    case 'ushort':
      return 'ushort';
    case 'char':
      return 'char';
    case 'uchar':
      return 'uchar';
    case 'double':
      return 'double';
    case 'float':
      return 'float';
    case 'bool':
      return 'bool';
    case 'string':
      return 'string';
    case 'datetime':
      return 'datetime';
    case 'color':
      return 'color';
    case 'void':
      return 'void';
    default:
      return undefined;
  }
}
