/**
 * Diagnostics (honesty layer) tests.
 *
 * Proves two things:
 *   (a) The GOOD sample EA (examples/MovingAverageCross.mq5) compiles with ZERO
 *       error diagnostics, and `checkCoverage` returns empty — i.e. the sample
 *       uses ONLY builtins the runtime really implements. This is the
 *       regression pin: if someone removes a real implementation or breaks the
 *       coverage table, the sample stops being fully covered and this fails.
 *   (b) The BAD fixture (examples/_DiagProbe.mq5) produces exactly the THREE
 *       expected fatal findings — one each of MQL_UNRESOLVED_NAME,
 *       MQL_UNKNOWN_CALL, and MQL_UNIMPLEMENTED_BUILTIN — so the landmine the
 *       completeness critic flagged (recognised-but-unimplemented builtins) is
 *       caught at compile time instead of throwing opaquely at run time.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { compileMql5ToIR } from '../src/compile';
import { checkCoverage } from '../src/runtime/coverage';
import { hasErrors, type Diagnostic, type DiagnosticCode } from '../src/diagnostics';

const SAMPLE_EA = resolve('examples/MovingAverageCross.mq5');
const RSI_EA = resolve('examples/RsiReversal.mq5');
const BAD_FIXTURE = resolve('examples/_DiagProbe.mq5');

/** Compile a fixture and return {module diagnostics, coverage diagnostics, merged}. */
function compileWithDiagnostics(absPath: string): {
  lowering: Diagnostic[];
  coverage: Diagnostic[];
  all: Diagnostic[];
} {
  const source = readFileSync(absPath, 'utf8');
  const mod = compileMql5ToIR(source, {
    name: 'test',
    filePath: absPath,
    sourceDir: dirname(absPath),
  });
  const lowering = mod.diagnostics ?? [];
  const coverage = checkCoverage(mod);
  return { lowering, coverage, all: [...lowering, ...coverage] };
}

/** Collect the set of error-severity diagnostic codes. */
function errorCodes(diagnostics: Diagnostic[]): DiagnosticCode[] {
  return diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
}

describe('diagnostics — the GOOD sample is fully covered', () => {
  it('compiles MovingAverageCross.mq5 with ZERO error diagnostics', () => {
    const { all } = compileWithDiagnostics(SAMPLE_EA);
    const errs = all.filter((d) => d.severity === 'error');
    // No errors — print any to aid debugging if this ever regresses.
    expect(errs, JSON.stringify(errs, null, 2)).toHaveLength(0);
    expect(hasErrors(all)).toBe(false);
  });

  it('checkCoverage returns empty for the sample (no unimplemented builtins)', () => {
    const source = readFileSync(SAMPLE_EA, 'utf8');
    const mod = compileMql5ToIR(source, {
      name: 'MovingAverageCross',
      filePath: SAMPLE_EA,
      sourceDir: dirname(SAMPLE_EA),
    });
    const coverage = checkCoverage(mod);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  // The SECOND sample EA — the harder one — must ALSO be fully covered now that
  // iRSI/iATR (Wilder RSI / MT5 SMA-of-True-Range), EventSetTimer/EventKillTimer,
  // and CTrade.BuyLimit/SellLimit/OrderDelete are real implementations. This pins
  // RsiReversal to ZERO error diagnostics: removing any of those real
  // implementations (or dropping its name from the coverage table) re-flags the
  // sample and fails here — the regression guard for the 2nd-EA milestone.
  it('compiles + fully covers RsiReversal.mq5 with ZERO error diagnostics', () => {
    const source = readFileSync(RSI_EA, 'utf8');
    const mod = compileMql5ToIR(source, {
      name: 'RsiReversal',
      filePath: RSI_EA,
      sourceDir: dirname(RSI_EA),
    });
    const lowering = mod.diagnostics ?? [];
    const coverage = checkCoverage(mod);
    const all = [...lowering, ...coverage];
    const errs = all.filter((d) => d.severity === 'error');
    expect(errs, JSON.stringify(errs, null, 2)).toHaveLength(0);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
    expect(hasErrors(all)).toBe(false);
  });
});

describe('diagnostics — the BAD fixture trips all three fatal findings', () => {
  it('produces exactly one each of the three expected error codes', () => {
    const { lowering, coverage, all } = compileWithDiagnostics(BAD_FIXTURE);

    const codes = errorCodes(all).sort();
    expect(codes).toEqual([
      'MQL_UNIMPLEMENTED_BUILTIN',
      'MQL_UNKNOWN_CALL',
      'MQL_UNRESOLVED_NAME',
    ]);

    // The unimplemented-builtin finding is a COVERAGE finding (not lowering).
    expect(errorCodes(coverage)).toEqual(['MQL_UNIMPLEMENTED_BUILTIN']);
    // The unresolved-name + unknown-call findings come from LOWERING.
    expect(errorCodes(lowering).sort()).toEqual([
      'MQL_UNKNOWN_CALL',
      'MQL_UNRESOLVED_NAME',
    ]);
  });

  it('MQL_UNRESOLVED_NAME names the undefined variable with a span', () => {
    const { all } = compileWithDiagnostics(BAD_FIXTURE);
    const d = all.find((x) => x.code === 'MQL_UNRESOLVED_NAME');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(d!.symbol).toBe('undefinedVariable');
    // Lowering diagnostics carry the source span (points back at the .mq5).
    expect(d!.span).toBeDefined();
    expect(d!.span!.line).toBeGreaterThan(0);
  });

  it('MQL_UNKNOWN_CALL names the undefined function with a span', () => {
    const { all } = compileWithDiagnostics(BAD_FIXTURE);
    const d = all.find((x) => x.code === 'MQL_UNKNOWN_CALL');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(d!.symbol).toBe('ThisIsNotAFunc');
    expect(d!.span).toBeDefined();
  });

  it('MQL_UNIMPLEMENTED_BUILTIN names the recognised-but-unimplemented builtin', () => {
    const { coverage } = compileWithDiagnostics(BAD_FIXTURE);
    const d = coverage.find((x) => x.code === 'MQL_UNIMPLEMENTED_BUILTIN');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    // iCustom is the honest remainder — custom-indicator transpilation is out
    // of PoC scope, so it has no handle ctor on the runtime. (iBands USED to be
    // the probe here but is now a REAL implementation — see the "implemented
    // indicators are covered" test below, which pins iBands/iMACD/iStochastic.)
    expect(d!.symbol).toBe('iCustom');
  });

  it('hasErrors() is true for the bad fixture (fatal policy gate)', () => {
    const { all } = compileWithDiagnostics(BAD_FIXTURE);
    expect(hasErrors(all)).toBe(true);
  });
});

describe('checkCoverage — recognised-but-unimplemented builtin enumeration', () => {
  it('flags the still-unimplemented builtin (iCustom) when used', () => {
    // iCustom is the honest remainder: custom-indicator transpilation is out of
    // PoC scope, so it has NO handle constructor on the runtime and must be
    // flagged (not silently shipped). NOTE: iMACD / iStochastic / iBands / iADX /
    // iCCI / iMomentum USED to be flagged here but are now REAL implementations
    // (IndicatorRegistry, MT5-source-faithful), so they are no longer flagged —
    // see the "does NOT flag implemented builtins" test below, which pins them
    // as covered.
    const src = `
int OnInit()
  {
   int c = iCustom(_Symbol, _Period, "MyIndicator", 14);
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'stubs' });
    const coverage = checkCoverage(mod);
    const symbols = coverage
      .filter((d) => d.code === 'MQL_UNIMPLEMENTED_BUILTIN')
      .map((d) => d.symbol)
      .sort();
    expect(symbols).toEqual(['iCustom']);
  });

  it('does NOT flag the indicators implemented this cycle (iMACD/iBands/iStochastic/iADX/iCCI/iMomentum)', () => {
    // These six gained REAL IndicatorRegistry implementations + CopyBuffer reads
    // this cycle (MT5-source-faithful recurrences + SetIndexBuffer order). None
    // must be flagged now that they compute real buffers.
    const src = `
int OnInit()
  {
   int hMacd  = iMACD(_Symbol, _Period, 12, 26, 9, PRICE_CLOSE);
   int hBands = iBands(_Symbol, _Period, 20, 0, 2.0, PRICE_CLOSE);
   int hStoch = iStochastic(_Symbol, _Period, 5, 3, 3, MODE_SMA, 0);
   int hAdx   = iADX(_Symbol, _Period, 14);
   int hCci   = iCCI(_Symbol, _Period, 20, PRICE_TYPICAL);
   int hMom   = iMomentum(_Symbol, _Period, 14, PRICE_CLOSE);
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'newIndicators' });
    const coverage = checkCoverage(mod);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('does NOT flag the host/series/read builtins implemented this cycle', () => {
    // A spread of the 58 newly-implemented builtins: math, string/convert,
    // extra array ops, scalar timeseries, extra copies, the pending-order pool,
    // history, and the honest-partial string reads. None must be flagged.
    const src = `
int OnInit()
  {
   double a = MathAbs(-1.5) + MathMax(2.0, 3.0) + MathSqrt(16.0) + MathPow(2.0, 3.0);
   string s = StringFormat("v=%.2f n=%d", a, 7);
   int    L = StringLen(s) + StringToInteger("42");
   string ds = DoubleToString(a, 3) + IntegerToString(7, 4);

   double buf[];
   ArraySetAsSeries(buf, true);
   ArrayResize(buf, 5);
   ArrayInitialize(buf, 0.0);
   int mx = ArrayMaximum(buf, 0, 5);
   int mn = ArrayMinimum(buf, 0, 5);
   ArraySort(buf);

   int nb = iBars(_Symbol, _Period);
   long v = iVolume(_Symbol, _Period, 0);
   int  hi = iHighest(_Symbol, _Period, MODE_HIGH, 10, 0);
   int  lo = iLowest(_Symbol, _Period, MODE_LOW, 10, 0);

   double tv[];
   CopyTickVolume(_Symbol, _Period, 0, 3, tv);

   int ot = OrdersTotal();
   if(OrderSelect(0))
     {
      double op = OrderGetDouble(ORDER_PRICE_OPEN);
      long   ty = OrderGetInteger(ORDER_TYPE);
     }

   HistorySelect(0, TimeCurrent());
   int hd = HistoryDealsTotal();

   string cur  = AccountInfoString(ACCOUNT_CURRENCY);
   string snam = SymbolInfoString(_Symbol, SYMBOL_NAME);
   bool   sel  = SymbolSelect(_Symbol, true);
   datetime srv = TimeTradeServer();
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'newHostSeriesReads' });
    const coverage = checkCoverage(mod);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('flags a still-unimplemented CTrade method (OrderModify) when used', () => {
    // OrderModify is recognised by the intrinsic table but NOT implemented on the
    // CTrade class — it must be flagged. (BuyLimit USED to be flagged here but is
    // now a real implementation routing to the pending-order book — see the
    // "does NOT flag implemented builtins" test below, which pins it as covered.)
    const src = `
#include <Trade/Trade.mqh>
CTrade trade;
int OnInit()
  {
   trade.OrderModify(12345, 1.10, 1.09, 1.12, ORDER_TIME_GTC, 0);
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'ctradegap' });
    const coverage = checkCoverage(mod);
    const d = coverage.find((x) => x.symbol === 'CTrade.OrderModify');
    expect(d).toBeDefined();
    expect(d!.code).toBe('MQL_UNIMPLEMENTED_BUILTIN');
  });

  it('does NOT flag implemented builtins / CTrade methods / context vars', () => {
    // Covers the builtins/methods made REAL this cycle: iRSI, iATR,
    // EventSetTimer/EventKillTimer, and CTrade.BuyLimit/SellLimit/OrderDelete —
    // alongside the previously-covered iMA / trade.Buy / context vars. None must
    // be flagged now that they are genuine implementations.
    const src = `
#include <Trade/Trade.mqh>
CTrade trade;
int OnInit()
  {
   int h  = iMA(_Symbol, _Period, 10, 0, MODE_SMA, PRICE_CLOSE);
   int hr = iRSI(_Symbol, _Period, 14, PRICE_CLOSE);
   int ha = iATR(_Symbol, _Period, 14);
   EventSetTimer(60);
   trade.Buy(0.1, _Symbol);
   trade.BuyLimit(0.1, 1.10, _Symbol);
   trade.SellLimit(0.1, 1.12, _Symbol);
   trade.OrderDelete(12345);
   EventKillTimer();
   Print(_Digits, _Point);
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'covered' });
    const coverage = checkCoverage(mod);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('does NOT flag builtin CONSTANTS in usedBuiltins (they are data on rt)', () => {
    // MODE_SMA / INVALID_HANDLE are constants — present on rt, never callable.
    const src = `
int OnInit()
  {
   int h = INVALID_HANDLE;
   int m = MODE_SMA;
   return(INIT_SUCCEEDED);
  }
`;
    const mod = compileMql5ToIR(src, { name: 'consts' });
    expect(mod.usedBuiltins).toContain('INVALID_HANDLE');
    expect(mod.usedBuiltins).toContain('MODE_SMA');
    expect(checkCoverage(mod)).toHaveLength(0);
  });
});

describe('diagnostics — unrecognised stdlib method (MQL_UNKNOWN_METHOD)', () => {
  it('flags an unknown method on a recognised stdlib class (CTrade)', () => {
    const src = `
#include <Trade/Trade.mqh>
CTrade trade;
void OnTick()
  {
   trade.Buy(0.1);                 // recognised — no diagnostic
   trade.TotallyBogusMethod(0.1);  // unknown on CTrade — MQL_UNKNOWN_METHOD
  }
`;
    const mod = compileMql5ToIR(src, { name: 'unknownMethod' });
    const d = (mod.diagnostics ?? []).find((x) => x.code === 'MQL_UNKNOWN_METHOD');
    expect(d).toBeDefined();
    expect(d!.severity).toBe('error');
    expect(d!.symbol).toBe('CTrade.TotallyBogusMethod');
    // The recognised method must NOT be flagged.
    expect(
      (mod.diagnostics ?? []).some((x) => x.symbol === 'CTrade.Buy'),
    ).toBe(false);
  });
});
