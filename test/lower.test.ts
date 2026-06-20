/**
 * Lowering tests — compileMql5ToIR on the sample EA.
 *
 * Asserts the resolved IR shape the backend + runtime depend on:
 *   - events.OnTick present and its IRFunction.isAsync === true (it calls the
 *     async trade methods, directly),
 *   - the iMA call lowered to an `intrinsic` target with isAsync === false,
 *   - trade.Buy lowered to a `method` target with isAsync === true,
 *   - InpFastPeriod resolves to an `input` ref binding.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { compileMql5ToIR } from '../src/compile';
import type {
  IRBlock,
  IRCall,
  IRExpr,
  IRFunction,
  IRModule,
  IRStmt,
} from '../src/ir/nodes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = resolve(__dirname, '../examples/MovingAverageCross.mq5');
const SAMPLE = readFileSync(SAMPLE_PATH, 'utf8');

function compileSample(): IRModule {
  return compileMql5ToIR(SAMPLE, { name: 'MovingAverageCross', filePath: SAMPLE_PATH });
}

describe('lower — module shape', () => {
  it('exposes the three inputs with folded defaults', () => {
    const mod = compileSample();
    const names = mod.inputs.map((i) => i.name);
    expect(names).toEqual(['InpFastPeriod', 'InpSlowPeriod', 'InpLots']);

    const fast = mod.inputs[0];
    expect(fast.type.prim).toBe('int');
    expect(fast.init?.kind).toBe('Num');
    expect((fast.init as { value: number }).value).toBe(10);

    const lots = mod.inputs[2];
    expect(lots.type.prim).toBe('double');
    expect((lots.init as { value: number; isFloat: boolean }).isFloat).toBe(true);
  });

  it('exposes the globals incl. the CTrade object', () => {
    const mod = compileSample();
    const gnames = mod.globals.map((g) => g.name);
    expect(gnames).toContain('fastHandle');
    expect(gnames).toContain('slowHandle');
    expect(gnames).toContain('trade');
    const trade = mod.globals.find((g) => g.name === 'trade')!;
    expect(trade.type.named).toBe('CTrade');
  });

  it('records the event handlers', () => {
    const mod = compileSample();
    expect(mod.events.OnInit).toBe('OnInit');
    expect(mod.events.OnDeinit).toBe('OnDeinit');
    expect(mod.events.OnTick).toBe('OnTick');
    // The function carries its event tag.
    const onTick = fn(mod, 'OnTick');
    expect(onTick.event).toBe('OnTick');
  });

  it('lists used builtins', () => {
    const mod = compileSample();
    expect(mod.usedBuiltins).toContain('iMA');
    expect(mod.usedBuiltins).toContain('CopyBuffer');
    expect(mod.usedBuiltins).toContain('ArraySetAsSeries');
    expect(mod.usedBuiltins).toContain('PositionSelect');
    expect(mod.usedBuiltins).toContain('INVALID_HANDLE');
    expect(mod.usedBuiltins).toContain('MODE_SMA');
    expect(mod.usedBuiltins).toContain('_Symbol');
  });
});

describe('lower — async classification', () => {
  it('OnTick is async (it issues trade calls)', () => {
    const mod = compileSample();
    const onTick = fn(mod, 'OnTick');
    expect(onTick.isAsync).toBe(true);
  });

  it('OnInit is NOT async (iMA / Print are synchronous)', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    expect(onInit.isAsync).toBe(false);
  });

  it('OnDeinit is NOT async', () => {
    const mod = compileSample();
    expect(fn(mod, 'OnDeinit').isAsync).toBe(false);
  });

  it('the iMA call is an intrinsic, isAsync === false', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    const calls = collectCalls(onInit.body);
    const ima = calls.find(
      (c) => c.target.kind === 'intrinsic' && c.target.info.name === 'iMA',
    );
    expect(ima).toBeDefined();
    expect(ima!.isAsync).toBe(false);
    if (ima!.target.kind === 'intrinsic') {
      expect(ima!.target.info.provider).toBe('feed');
    }
  });

  it('trade.Buy is a method call, isAsync === true', () => {
    const mod = compileSample();
    const onTick = fn(mod, 'OnTick');
    const calls = collectCalls(onTick.body);
    const buy = calls.find((c) => c.target.kind === 'method' && c.target.method === 'Buy');
    expect(buy).toBeDefined();
    expect(buy!.isAsync).toBe(true);
    if (buy!.target.kind === 'method') {
      expect(buy!.target.info?.isAsync).toBe(true);
      expect(buy!.target.info?.provider).toBe('broker');
    }
  });

  it('trade.PositionClose is async; PositionSelect is a sync intrinsic', () => {
    const mod = compileSample();
    const onTick = fn(mod, 'OnTick');
    const calls = collectCalls(onTick.body);

    const close = calls.find(
      (c) => c.target.kind === 'method' && c.target.method === 'PositionClose',
    );
    expect(close?.isAsync).toBe(true);

    const select = calls.find(
      (c) => c.target.kind === 'intrinsic' && c.target.info.name === 'PositionSelect',
    );
    expect(select).toBeDefined();
    expect(select!.isAsync).toBe(false);
    if (select!.target.kind === 'intrinsic') {
      expect(select!.target.info.provider).toBe('broker');
    }
  });
});

describe('lower — binding resolution', () => {
  it('InpFastPeriod resolves to an input ref', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    const refs = collectRefs(onInit.body);
    const inpRef = refs.find(
      (r) => r.binding.kind === 'input' && r.binding.name === 'InpFastPeriod',
    );
    expect(inpRef).toBeDefined();
  });

  it('_Symbol resolves to a contextVar ref', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    const refs = collectRefs(onInit.body);
    expect(
      refs.some((r) => r.binding.kind === 'contextVar' && r.binding.name === '_Symbol'),
    ).toBe(true);
  });

  it('MODE_SMA / INVALID_HANDLE resolve to builtinConst refs', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    const refs = collectRefs(onInit.body);
    expect(
      refs.some((r) => r.binding.kind === 'builtinConst' && r.binding.name === 'MODE_SMA'),
    ).toBe(true);
    expect(
      refs.some((r) => r.binding.kind === 'builtinConst' && r.binding.name === 'INVALID_HANDLE'),
    ).toBe(true);
  });

  it('fastHandle resolves to a global ref', () => {
    const mod = compileSample();
    const onInit = fn(mod, 'OnInit');
    const refs = collectRefs(onInit.body);
    expect(
      refs.some((r) => r.binding.kind === 'global' && r.binding.name === 'fastHandle'),
    ).toBe(true);
  });
});

describe('lower — integer arithmetic flag', () => {
  it('marks int/int division as intArith and folds constants', () => {
    const mod = compileMql5ToIR(
      'void OnTick(){ int a = 7; int b = 2; int c = a / b; int d = 10 / 4; }',
      { name: 'M' },
    );
    const onTick = fn(mod, 'OnTick');
    const bins = collectBinaries(onTick.body);
    const div = bins.find((b) => b.op === '/');
    expect(div).toBeDefined();
    expect(div!.intArith).toBe(true);

    // `10 / 4` is constant-folded to 2 (truncated integer division).
    const nums = collectNums(onTick.body);
    expect(nums.some((n) => n.value === 2 && !n.isFloat)).toBe(true);
  });

  it('double/int division is NOT intArith', () => {
    const mod = compileMql5ToIR('void OnTick(){ double a = 7.0; int b = 2; double c = a / b; }', {
      name: 'M',
    });
    const onTick = fn(mod, 'OnTick');
    const div = collectBinaries(onTick.body).find((b) => b.op === '/');
    expect(div?.intArith).toBe(false);
  });
});

describe('lower — async fixpoint through user functions', () => {
  it('a helper that issues a trade is async, and its caller becomes async', () => {
    const src = `
      CTrade trade;
      void doTrade(){ trade.Buy(0.1, _Symbol); }
      void OnTick(){ doTrade(); }
    `;
    const mod = compileMql5ToIR(src, { name: 'M' });
    expect(fn(mod, 'doTrade').isAsync).toBe(true);
    expect(fn(mod, 'OnTick').isAsync).toBe(true);

    // The call to doTrade inside OnTick is awaited (isAsync mirrored).
    const calls = collectCalls(fn(mod, 'OnTick').body);
    const userCall = calls.find((c) => c.target.kind === 'user' && c.target.name === 'doTrade');
    expect(userCall?.isAsync).toBe(true);
  });

  it('a pure helper stays sync', () => {
    const src = `
      int add(int a, int b){ return(a + b); }
      void OnTick(){ int x = add(1, 2); }
    `;
    const mod = compileMql5ToIR(src, { name: 'M' });
    expect(fn(mod, 'add').isAsync).toBe(false);
    expect(fn(mod, 'OnTick').isAsync).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────

function fn(mod: IRModule, name: string): IRFunction {
  const f = mod.functions.find((x) => x.name === name);
  if (!f) throw new Error(`function ${name} not found`);
  return f;
}

function collectCalls(block: IRBlock): IRCall[] {
  const out: IRCall[] = [];
  walk(block, (n) => {
    if (isExpr(n) && n.kind === 'Call') out.push(n);
  });
  return out;
}

function collectRefs(block: IRBlock): Array<IRExpr & { kind: 'Ref' }> {
  const out: Array<IRExpr & { kind: 'Ref' }> = [];
  walk(block, (n) => {
    if (isExpr(n) && n.kind === 'Ref') out.push(n);
  });
  return out;
}

function collectBinaries(block: IRBlock): Array<IRExpr & { kind: 'Binary' }> {
  const out: Array<IRExpr & { kind: 'Binary' }> = [];
  walk(block, (n) => {
    if (isExpr(n) && n.kind === 'Binary') out.push(n);
  });
  return out;
}

function collectNums(block: IRBlock): Array<IRExpr & { kind: 'Num' }> {
  const out: Array<IRExpr & { kind: 'Num' }> = [];
  walk(block, (n) => {
    if (isExpr(n) && n.kind === 'Num') out.push(n);
  });
  return out;
}

function isExpr(n: unknown): n is IRExpr {
  return !!n && typeof n === 'object' && typeof (n as { kind?: unknown }).kind === 'string';
}

/** Generic structural walk over IR nodes (blocks/stmts/exprs). */
function walk(node: unknown, visit: (n: IRStmt | IRExpr) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof (node as { kind?: unknown }).kind === 'string') {
    visit(node as IRStmt | IRExpr);
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) v.forEach((x) => walk(x, visit));
    else if (v && typeof v === 'object') walk(v, visit);
  }
}
