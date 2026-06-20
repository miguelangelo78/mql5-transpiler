/**
 * OOP / frontend surface tests — user classes-with-methods, single inheritance,
 * templates (type-erased), and the builtin trade-struct emission
 * (MqlTradeRequest / MqlTradeResult / OrderSend).
 *
 * Two layers per case (mirroring emit.test.ts):
 *   1. SHAPE — compile MQL5 source end-to-end (compileMql5ToIR → emitTypeScript)
 *      and assert the emitted TS has the structural anchors the design requires
 *      (a real `class Foo {...}`, `new Foo()`, `this.method()`, `extends Base`,
 *      `new rt.MqlTradeRequest()`, `await rt.OrderSend(...)`).
 *   2. RUNNABILITY — write the emitted module to a temp file, import it under
 *      tsx with a STUB `rt`, drive a handler, and assert it executes (the class
 *      methods + trade-struct shapes actually run, no throw).
 *
 * The runtime classes (MqlTradeRequest/MqlTradeResult) + rt.OrderSend are built
 * in a later phase; here we provide them as stubs (a class + an async fn) — this
 * suite verifies the EMISSION + the executable shape, not the runtime impl.
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileMql5ToIR } from '../src/compile';
import { emitTypeScript } from '../src/backend/typescript/emit';
import type { IRModule } from '../src/ir/nodes';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function compile(src: string, name = 'OopTest'): IRModule {
  return compileMql5ToIR(src, { name });
}

function emit(src: string, name = 'OopTest'): string {
  return emitTypeScript(compile(src, name));
}

/** Errors only (warnings like preprocessor advisories don't fail a test). */
function errorDiagnostics(mod: IRModule): string[] {
  return (mod.diagnostics ?? [])
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.code}:${d.symbol ?? d.message}`);
}

/**
 * Write the emitted module + a harness to a temp file, import under tsx, run
 * `__run()`, return its result. The harness appends its own exported entry so
 * the emitted `createExpert` is exercised with a stub `rt`.
 */
async function runEmitted(emitted: string, harnessTail: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'mql5-oop-'));
  const file = join(dir, 'emitted.ts');
  try {
    await writeFile(file, `${emitted}\n${harnessTail}\n`, 'utf8');
    const mod = await import(pathToFileURL(file).href);
    return await mod.__run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (a) User class with a method that is called
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — user class with methods', () => {
  const SRC = `
class Counter {
  int value;
  void reset() { value = 0; }
  void add(int n) { value = value + n; }
  int get() { return value; }
};

int gResult;
void OnTick() {
  Counter c;
  c.reset();
  c.add(5);
  c.add(3);
  gResult = c.get();
}
`;

  it('compiles with no error diagnostics', () => {
    expect(errorDiagnostics(compile(SRC))).toEqual([]);
  });

  it('emits a real TS class with field default + methods', () => {
    const src = emit(SRC);
    expect(src).toContain('class Counter {');
    // field → property with a zero-default (§29: 0 is a real value)
    expect(src).toContain('value = 0;');
    // methods → TS methods
    expect(src).toContain('reset() {');
    expect(src).toContain('add(n) {');
    expect(src).toContain('get() {');
    // `this.field` resolution for the implicit `this`
    expect(src).toContain('this.value = this.value + n;');
    expect(src).toContain('return this.value;');
  });

  it('constructs the instance with `new Counter()` (bare, not via rt)', () => {
    const src = emit(SRC);
    expect(src).toContain('new Counter()');
    expect(src).not.toContain('new rt.Counter(');
  });

  it('emits member method calls as receiver.method(...)', () => {
    const src = emit(SRC);
    expect(src).toContain('c.reset();');
    expect(src).toContain('c.add(5);');
    expect(src).toContain('c.get()');
  });

  it('runs: OnTick drives the class methods without throwing', async () => {
    // The handler constructs Counter, calls reset/add/get, and stores the
    // result in a module global. We assert it executes end-to-end (the
    // OBSERVABLE return value is covered by the OnInit-returns test below).
    const tail = `
export async function __run() {
  const rt = {};
  const ea = createExpert(rt, {});
  ea.OnTick();
  return { ok: true };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (a') Method return value is observable — class round-trips through a handler
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — class state round-trips through a handler', () => {
  // OnCalculate returns an int; we make it return the computed counter value so
  // the test can OBSERVE the class method result (not just "didn't throw").
  const SRC = `
class Counter {
  int value;
  void add(int n) { value = value + n; }
  int get() { return value; }
};

int OnInit() {
  Counter c;
  c.add(5);
  c.add(3);
  return c.get();
}
void OnTick() {}
`;

  it('OnInit returns the class-computed value (8)', async () => {
    const tail = `
export async function __run() {
  const rt = {};
  const ea = createExpert(rt, {});
  return { ret: ea.OnInit() };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { ret: number };
    expect(result.ret).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (a'') Single inheritance — `extends Base`, inherited fields + methods
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — single inheritance', () => {
  const SRC = `
class Base {
  int b;
  void setBase(int v) { b = v; }
  int baseVal() { return b; }
};
class Derived : Base {
  int d;
  void setD(int v) { d = v; }
  int total() { return baseVal() + d; }
};

int OnInit() {
  Derived obj;
  obj.setBase(10);
  obj.setD(7);
  return obj.total();
}
void OnTick() {}
`;

  it('compiles with no error diagnostics', () => {
    expect(errorDiagnostics(compile(SRC))).toEqual([]);
  });

  it('emits `class Derived extends Base`', () => {
    expect(emit(SRC)).toContain('class Derived extends Base {');
  });

  it('resolves an inherited method call through implicit this (this.baseVal())', () => {
    expect(emit(SRC)).toContain('return this.baseVal() + this.d;');
  });

  it('runs: inherited field + method give 10 + 7 = 17', async () => {
    const tail = `
export async function __run() {
  const rt = {};
  const ea = createExpert(rt, {});
  return { ret: ea.OnInit() };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { ret: number };
    expect(result.ret).toBe(17);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (a''') A class method that trades is ASYNC (fixpoint) + its callers awaited
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — a trading method is async and its callers awaited', () => {
  const SRC = `
class Trader {
  CTrade trade;
  void fire(double lots) { trade.Buy(lots, _Symbol); }
  void go() { fire(0.1); }
};

void OnTick() {
  Trader t;
  t.go();
}
`;

  it('marks the trading method AND its transitive caller async', () => {
    const mod = compile(SRC);
    const trader = mod.classes?.find((c) => c.name === 'Trader');
    expect(trader).toBeDefined();
    const fire = trader!.methods.find((m) => m.name === 'fire');
    const go = trader!.methods.find((m) => m.name === 'go');
    expect(fire?.isAsync).toBe(true); // calls trade.Buy (broker I/O)
    expect(go?.isAsync).toBe(true); // transitively, via fire()
  });

  it('emits async methods and awaits every async call site', () => {
    const src = emit(SRC);
    expect(src).toContain('async fire(lots) {');
    expect(src).toContain('async go() {');
    expect(src).toContain('await this.trade.Buy(');
    expect(src).toContain('await this.fire(0.1);');
    expect(src).toContain('await t.go();'); // the handler awaits the async method
  });

  it('runs end-to-end with a stub CTrade (the trade fires once)', async () => {
    const tail = `
export async function __run() {
  let buyCalls = 0;
  const rt = {
    _Symbol: 'EURUSD',
    CTrade: class {
      constructor(rt) { this.rt = rt; }
      async Buy(lots, symbol) { buyCalls++; return true; }
    },
  };
  const ea = createExpert(rt, {});
  await ea.OnTick();
  return { buyCalls };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { buyCalls: number };
    expect(result.buyCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (a'''') Explicit constructor (with args), destructor, super() chaining,
//          object-pointer `new`, and `delete`
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — constructors, destructors, super chaining, pointers', () => {
  const SRC = `
class Widget {
  int id;
  Widget(int initialId) { id = initialId; }
  ~Widget() { id = 0; }
  int getId() { return id; }
};
class Base { int b; Base() { b = 1; } };
class Sub : Base { int s; Sub() { s = 2; } int total() { return b + s; } };

int OnInit() {
  Widget *w;
  w = new Widget(99);
  int got = w.getId();
  delete w;
  Sub sub;
  return got + sub.total();
}
void OnTick() {}
`;

  it('compiles with no error diagnostics', () => {
    expect(errorDiagnostics(compile(SRC))).toEqual([]);
  });

  it('emits the MQL5 constructor as a TS constructor with args', () => {
    const src = emit(SRC);
    expect(src).toContain('constructor(initialId) {');
    expect(src).toContain('this.id = initialId;');
  });

  it('emits the destructor as a __dtor() method', () => {
    expect(emit(SRC)).toContain('__dtor() {');
  });

  it('chains super() in a derived constructor (TS requires it before `this`)', () => {
    const src = emit(SRC);
    // Sub's constructor must call super() before `this.s = 2`.
    const subCtor = src.slice(src.indexOf('class Sub extends Base'));
    expect(subCtor).toContain('super();');
    expect(subCtor.indexOf('super();')).toBeLessThan(subCtor.indexOf('this.s = 2;'));
  });

  it('object-pointer `new Widget(args)` is bare; `delete` uses the runtime hook', () => {
    const src = emit(SRC);
    expect(src).toContain('w = new Widget(99);');
    expect(src).toContain('rt.__delete(w);');
  });

  it('runs: ctor arg (99) + inherited ctors (1 + 2 = 3) ⇒ 102', async () => {
    const tail = `
export async function __run() {
  const rt = { __delete(obj) { if (obj && typeof obj.__dtor === 'function') obj.__dtor(); } };
  const ea = createExpert(rt, {});
  return { ret: ea.OnInit() };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { ret: number };
    expect(result.ret).toBe(102);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) Templated helpers (class + free function) — type-erased
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — templates (type-erased)', () => {
  const SRC = `
template<typename T>
class Box {
  T item;
  void put(T x) { item = x; }
  T fetch() { return item; }
};

template<typename T>
T pickMax(T a, T b) { return a > b ? a : b; }

int OnInit() {
  Box b;
  b.put(42);
  int x = b.fetch();
  int m = pickMax(3, 9);
  return x + m;
}
void OnTick() {}
`;

  it('compiles with no error diagnostics', () => {
    expect(errorDiagnostics(compile(SRC))).toEqual([]);
  });

  it('records the template params on the IR class but erases at emit', () => {
    const mod = compile(SRC);
    const box = mod.classes?.find((c) => c.name === 'Box');
    expect(box?.templateParams).toEqual(['T']);
  });

  it('emits the templated class un-monomorphised (a plain TS class)', () => {
    const src = emit(SRC);
    expect(src).toContain('class Box {');
    expect(src).toContain('put(x) {'); // T-param erased to an untyped param
    expect(src).toContain('fetch() {');
    // The erasure is documented in the output (honesty §21).
    expect(src).toContain('type-erased');
  });

  it('emits the templated free function un-monomorphised', () => {
    const src = emit(SRC);
    expect(src).toContain('function pickMax(a, b) {');
    expect(src).toContain('(a > b) ? a : b');
  });

  it('runs: the templated class + function produce 42 + 9 = 51', async () => {
    const tail = `
export async function __run() {
  const rt = {};
  const ea = createExpert(rt, {});
  return { ret: ea.OnInit() };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as { ret: number };
    expect(result.ret).toBe(51);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) Builtin trade structs + OrderSend emission
// ─────────────────────────────────────────────────────────────────────────

describe('OOP — MqlTradeRequest / MqlTradeResult / OrderSend', () => {
  // Use ORDER_TYPE_BUY (a constant that exists in the runtime constants table)
  // for `req.type` so there are no unresolved-name diagnostics; the field
  // assignments + the OrderSend call are what we assert.
  const SRC = `
void OnTick() {
  MqlTradeRequest req;
  MqlTradeResult res;
  req.type = ORDER_TYPE_BUY;
  req.symbol = _Symbol;
  req.volume = 0.1;
  OrderSend(req, res);
}
`;

  it('constructs the structs as `new rt.MqlTradeRequest()` / `new rt.MqlTradeResult()`', () => {
    const src = emit(SRC);
    expect(src).toContain('let req = new rt.MqlTradeRequest();');
    expect(src).toContain('let res = new rt.MqlTradeResult();');
  });

  it('emits field assignments verbatim (req.type = ..., req.symbol = ...)', () => {
    const src = emit(SRC);
    expect(src).toContain('req.type = rt.ORDER_TYPE_BUY;');
    expect(src).toContain('req.symbol = rt._Symbol;');
    expect(src).toContain('req.volume = 0.1;');
  });

  it('emits OrderSend as an awaited broker I/O call `await rt.OrderSend(req, res)`', () => {
    const src = emit(SRC);
    expect(src).toContain('await rt.OrderSend(req, res)');
    // the handler that contains an awaited OrderSend must itself be async
    expect(src).toContain('async function OnTick() {');
  });

  it('records the runtime structs + OrderSend in usedBuiltins', () => {
    const mod = compile(SRC);
    expect(mod.usedBuiltins).toContain('MqlTradeRequest');
    expect(mod.usedBuiltins).toContain('MqlTradeResult');
    expect(mod.usedBuiltins).toContain('OrderSend');
  });

  it('runs end-to-end with a stub MqlTradeRequest class + async OrderSend', async () => {
    const tail = `
export async function __run() {
  let sent = null;
  const rt = {
    _Symbol: 'EURUSD',
    ORDER_TYPE_BUY: 0,
    MqlTradeRequest: class { constructor() { this.type = 0; this.symbol = ''; this.volume = 0; } },
    MqlTradeResult: class { constructor() { this.retcode = 0; } },
    async OrderSend(req, res) { sent = { type: req.type, symbol: req.symbol, volume: req.volume }; res.retcode = 10009; return true; },
  };
  const ea = createExpert(rt, {});
  await ea.OnTick();
  return { sent };
}
`;
    const result = (await runEmitted(emit(SRC), tail)) as {
      sent: { type: number; symbol: string; volume: number } | null;
    };
    // The emitted code built the request, assigned its fields, and awaited
    // OrderSend with (req, res) — the stub captured the populated request.
    expect(result.sent).toEqual({ type: 0, symbol: 'EURUSD', volume: 0.1 });
  });
});
