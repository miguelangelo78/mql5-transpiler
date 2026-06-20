/**
 * TypeScript backend tests — emitTypeScript(mod).
 *
 * Two layers:
 *  1. STRING shape — hand-build a small IRModule per ../src/ir/nodes.ts and
 *     assert the emitted source contains the structural anchors the emission
 *     ABI requires (export factory, async handler, await on async calls, the
 *     `rt.iMA(` intrinsic call, the `new rt.CTrade(rt` construction).
 *  2. RUNNABILITY — write the emitted module to a temp file, dynamic-import it
 *     under tsx with a STUB `rt`, run `createExpert(stub).OnTick()` and assert
 *     it does not throw (i.e. the emitted code is syntactically valid AND its
 *     control flow / await / call shapes actually execute).
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitTypeScript } from '../src/backend/typescript/emit';
import type {
  IRModule,
  IRInput,
  IRGlobal,
  IRFunction,
  IRExpr,
  IRStmt,
} from '../src/ir/nodes';
import { T } from '../src/ir/nodes';

// ─────────────────────────────────────────────────────────────────────────
// Hand-built IR for a minimal EA, mirroring the sample EA's shape:
//
//   input double InpLots = 0.1;            // one input, folded default
//   int fastHandle = INVALID_HANDLE;       // one scalar global
//   CTrade trade;                          // a CTrade global
//
//   async void OnTick() {                  // async (it awaits a trade call)
//     double v = iMA(_Symbol, _Period, 10, 0, MODE_SMA, PRICE_CLOSE); // sync intrinsic
//     trade.Buy(InpLots, _Symbol);                                    // async method
//   }
// ─────────────────────────────────────────────────────────────────────────

function num(value: number, isFloat = false): IRExpr {
  return { kind: 'Num', value, isFloat, type: isFloat ? T.double : T.int };
}

function buildModule(): IRModule {
  const inputs: IRInput[] = [
    { name: 'InpLots', type: T.double, init: num(0.1, true), label: 'Trade volume (lots)' },
  ];

  const globals: IRGlobal[] = [
    {
      name: 'fastHandle',
      type: T.int,
      init: { kind: 'Ref', binding: { kind: 'builtinConst', name: 'INVALID_HANDLE' }, type: T.int },
      isConst: false,
      isStatic: false,
      arrayDims: [],
    },
    {
      name: 'trade',
      type: { named: 'CTrade' },
      isConst: false,
      isStatic: false,
      arrayDims: [],
    },
  ];

  // double v = iMA(_Symbol, _Period, 10, 0, MODE_SMA, PRICE_CLOSE);  (sync)
  const iMACall: IRExpr = {
    kind: 'Call',
    target: {
      kind: 'intrinsic',
      info: { provider: 'feed', name: 'iMA', isAsync: false },
    },
    args: [
      { kind: 'Ref', binding: { kind: 'contextVar', name: '_Symbol' }, type: T.string },
      { kind: 'Ref', binding: { kind: 'contextVar', name: '_Period' }, type: T.int },
      num(10),
      num(0),
      { kind: 'Ref', binding: { kind: 'builtinConst', name: 'MODE_SMA' }, type: T.int },
      { kind: 'Ref', binding: { kind: 'builtinConst', name: 'PRICE_CLOSE' }, type: T.int },
    ],
    isAsync: false,
    type: T.double,
  };

  const vDecl: IRStmt = {
    kind: 'VarDecl',
    name: 'v',
    type: T.double,
    init: iMACall,
    arrayDims: [],
    isConst: false,
  };

  // trade.Buy(InpLots, _Symbol);  (async method on the CTrade global)
  const buyCall: IRExpr = {
    kind: 'Call',
    target: {
      kind: 'method',
      receiver: { kind: 'Ref', binding: { kind: 'global', name: 'trade' }, type: { named: 'CTrade' } },
      method: 'Buy',
      info: { provider: 'broker', name: 'Buy', isAsync: true },
    },
    args: [
      { kind: 'Ref', binding: { kind: 'input', name: 'InpLots' }, type: T.double },
      { kind: 'Ref', binding: { kind: 'contextVar', name: '_Symbol' }, type: T.string },
    ],
    isAsync: true,
    type: T.bool,
  };

  const buyStmt: IRStmt = { kind: 'ExprStmt', expr: buyCall };

  const onTick: IRFunction = {
    name: 'OnTick',
    returnType: T.void,
    params: [],
    body: { kind: 'Block', body: [vDecl, buyStmt] },
    isAsync: true,
    event: 'OnTick',
  };

  return {
    name: 'MiniCross',
    inputs,
    globals,
    functions: [onTick],
    usedBuiltins: ['iMA', 'INVALID_HANDLE', 'MODE_SMA', 'PRICE_CLOSE', 'CTrade'],
    events: { OnTick: 'OnTick' },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. String-shape assertions
// ─────────────────────────────────────────────────────────────────────────

describe('emitTypeScript — emitted source shape', () => {
  const src = emitTypeScript(buildModule());

  it('emits the createExpert factory', () => {
    expect(src).toContain('export function createExpert(rt, inputs = {}) {');
  });

  it('seeds inputs with ?? (zero-valid) and the folded default', () => {
    expect(src).toContain('let InpLots = (inputs.InpLots ?? 0.1);');
  });

  it('emits a builtinConst ref through rt', () => {
    expect(src).toContain('let fastHandle = rt.INVALID_HANDLE;');
  });

  it('constructs a CTrade global as new rt.CTrade(rt)', () => {
    expect(src).toContain('const trade = new rt.CTrade(rt);');
  });

  it('emits an async event handler', () => {
    expect(src).toContain('async function OnTick() {');
  });

  it('emits a sync intrinsic as rt.iMA( with no await', () => {
    expect(src).toContain('rt.iMA(');
    // The iMA call site must NOT be awaited (it is sync).
    expect(src).not.toContain('await rt.iMA(');
  });

  it('passes context vars through rt (rt._Symbol, rt._Period)', () => {
    expect(src).toContain('rt._Symbol');
    expect(src).toContain('rt._Period');
  });

  it('awaits the async trade method call', () => {
    expect(src).toContain('await trade.Buy(');
  });

  it('returns the handler map with __inputs', () => {
    expect(src).toContain('return {');
    expect(src).toContain('OnTick,');
    expect(src).toContain('__inputs: { InpLots },');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The emitted module actually runs
// ─────────────────────────────────────────────────────────────────────────

describe('emitTypeScript — emitted module runs under tsx', () => {
  it('createExpert(stub).OnTick() executes without throwing', async () => {
    const src = emitTypeScript(buildModule());

    // A stub Runtime: iMA returns 1; CTrade is a class with an async Buy that
    // records its call. Only what the emitted OnTick touches needs to exist.
    const harness = `
${src}

export async function __run() {
  let buyCalls = 0;
  const stubRt = {
    _Symbol: 'EURUSD',
    _Period: 0,
    INVALID_HANDLE: -1,
    MODE_SMA: 0,
    PRICE_CLOSE: 1,
    iMA(/* ...args */) { return 1; },
    CTrade: class {
      constructor(rt) { this.rt = rt; }
      async Buy(volume, symbol) { buyCalls++; return true; }
    },
  };

  const ea = createExpert(stubRt, {});
  await ea.OnTick();

  return { buyCalls, inputs: ea.__inputs };
}
`;

    const dir = await mkdtemp(join(tmpdir(), 'mql5-emit-'));
    const file = join(dir, 'emitted.ts');
    try {
      await writeFile(file, harness, 'utf8');
      const mod = await import(pathToFileURL(file).href);
      const result = await mod.__run();

      // OnTick ran end-to-end: it reached the awaited trade.Buy exactly once.
      expect(result.buyCalls).toBe(1);
      // The factory exposed the resolved inputs (default applied, zero-valid ??).
      expect(result.inputs).toEqual({ InpLots: 0.1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies an input override (including a 0 override, §29 zero-valid)', async () => {
    const src = emitTypeScript(buildModule());
    const harness = `
${src}

export function __inputsFor(overrides) {
  const stubRt = {
    _Symbol: 'EURUSD', _Period: 0, INVALID_HANDLE: -1, MODE_SMA: 0, PRICE_CLOSE: 1,
    iMA() { return 1; },
    CTrade: class { async Buy() { return true; } },
  };
  return createExpert(stubRt, overrides).__inputs;
}
`;
    const dir = await mkdtemp(join(tmpdir(), 'mql5-emit-'));
    const file = join(dir, 'emitted2.ts');
    try {
      await writeFile(file, harness, 'utf8');
      const mod = await import(pathToFileURL(file).href);
      // A real override is honoured.
      expect(mod.__inputsFor({ InpLots: 0.25 })).toEqual({ InpLots: 0.25 });
      // A 0 override is a VALID value (§29) — NOT replaced by the default.
      expect(mod.__inputsFor({ InpLots: 0 })).toEqual({ InpLots: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
