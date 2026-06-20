/**
 * Harden tests — the §21/robustness findings from adversarial review.
 *
 * Each finding is a real landmine; these pin the LOUD/correct behaviour so a
 * regression re-introduces a silent drop or an opaque crash:
 *
 *  1. Overloading (free fn OR class method) is detected at lowering and reported
 *     as MQL_UNSUPPORTED_OVERLOAD — NOT silently dropped to the last definition.
 *  2. Out-of-line method definitions (`void Class::method(){…}`) and operator
 *     overloads (`Type operator+(…)`) produce a clean MQL_UNSUPPORTED_CONSTRUCT
 *     diagnostic and do NOT throw a ParseError; the rest of the file still
 *     parses + lowers.
 *  3. A recognised-but-unimplemented Standard-Library class (CiMA) is FLAGGED by
 *     checkCoverage (the stdlib-class landmine), exactly like an unimplemented
 *     free builtin; the IMPLEMENTED classes (CPositionInfo/CSymbolInfo/
 *     CAccountInfo) are NOT flagged.
 *  4. OrderSend TRADE_ACTION_SLTP keys on request.position (the position ticket),
 *     resolving it to the position's symbol — not on request.symbol.
 */

import { describe, expect, it } from 'vitest';

import { compileMql5ToIR } from '../src/compile';
import { checkCoverage } from '../src/runtime/coverage';
import { hasErrors, type Diagnostic } from '../src/diagnostics';
import { orderSend } from '../src/runtime/orderSend';
import { MqlTradeRequest, MqlTradeResult } from '../src/runtime/mqlStructs';
import { MQL_CONST } from '../src/runtime/constants';
import type {
  AccountInfo,
  IBroker,
  OrderRequest,
  Position,
  TradeResult,
} from '../src/runtime/providers/types';

/** Compile a source string and return all diagnostics (lowering + coverage). */
function diagnose(src: string): Diagnostic[] {
  const mod = compileMql5ToIR(src, { name: 'harden' });
  return [...(mod.diagnostics ?? []), ...checkCoverage(mod)];
}

function codesFor(diags: Diagnostic[], code: string): Diagnostic[] {
  return diags.filter((d) => d.code === code);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Overloading — loud, not silently dropped
// ─────────────────────────────────────────────────────────────────────────

describe('FIX 1 — overloading is reported (MQL_UNSUPPORTED_OVERLOAD), never silently dropped', () => {
  it('flags an overloaded FREE function naming the symbol', () => {
    const src = `
int add(int a){ return a; }
int add(int a, int b){ return a + b; }
void OnTick(){ int x = add(1); }
`;
    const diags = diagnose(src);
    const overloads = codesFor(diags, 'MQL_UNSUPPORTED_OVERLOAD');
    expect(overloads).toHaveLength(1);
    expect(overloads[0]!.severity).toBe('error');
    expect(overloads[0]!.symbol).toBe('add');
    expect(hasErrors(diags)).toBe(true);
  });

  it('flags an overloaded CLASS METHOD naming Class.method', () => {
    const src = `
class C {
public:
  void f(int a){ }
  void f(double a){ }
};
void OnTick(){ }
`;
    const diags = diagnose(src);
    const overloads = codesFor(diags, 'MQL_UNSUPPORTED_OVERLOAD');
    expect(overloads).toHaveLength(1);
    expect(overloads[0]!.symbol).toBe('C.f');
  });

  it('does NOT flag a prototype + single definition (not an overload)', () => {
    // A forward prototype (no body) followed by ONE definition is legal MQL5 —
    // it must NOT be reported as an overload.
    const src = `
int compute(int a);
int compute(int a){ return a * 2; }
void OnTick(){ int x = compute(3); }
`;
    const diags = diagnose(src);
    expect(codesFor(diags, 'MQL_UNSUPPORTED_OVERLOAD')).toHaveLength(0);
  });

  it('does NOT flag distinct function names', () => {
    const src = `
int a1(int a){ return a; }
int a2(int a){ return a + 1; }
void OnTick(){ }
`;
    expect(codesFor(diagnose(src), 'MQL_UNSUPPORTED_OVERLOAD')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Out-of-line methods + operator overloads — clean diagnostic, no throw
// ─────────────────────────────────────────────────────────────────────────

describe('FIX 2 — unsupported constructs produce MQL_UNSUPPORTED_CONSTRUCT, never a ParseError', () => {
  it('an out-of-line method definition does NOT throw and is flagged', () => {
    const src = `
class CFoo {
public:
  void bar(int x);
  int y;
};
void CFoo::bar(int x){ this.y = x; }
void OnTick(){ }
`;
    // The whole point: compiling must NOT throw.
    expect(() => compileMql5ToIR(src, { name: 'oolm' })).not.toThrow();
    const diags = diagnose(src);
    const cons = codesFor(diags, 'MQL_UNSUPPORTED_CONSTRUCT');
    expect(cons.length).toBeGreaterThanOrEqual(1);
    expect(cons[0]!.severity).toBe('error');
    expect(cons[0]!.message).toMatch(/out-of-line/i);
  });

  it('an operator overload does NOT throw and is flagged', () => {
    const src = `
class V {
public:
  double x;
  V operator+(const V &o){ V r; r.x = this.x + o.x; return r; }
};
void OnTick(){ }
`;
    expect(() => compileMql5ToIR(src, { name: 'op' })).not.toThrow();
    const cons = codesFor(diagnose(src), 'MQL_UNSUPPORTED_CONSTRUCT');
    expect(cons.length).toBeGreaterThanOrEqual(1);
    expect(cons[0]!.message).toMatch(/operator/i);
  });

  it('recovers: valid declarations AFTER a skipped construct still lower', () => {
    // The operator overload is skipped, but the sibling method Len(), the free
    // function helper(), and OnTick must all still be present in the IR.
    const src = `
class V {
public:
  double x;
  V operator+(const V &o){ V r; r.x = this.x + o.x; return r; }
  double Len(){ return this.x * this.x; }
};
double helper(double a){ return a * 2; }
void OnTick(){ V v; v.x = 3; double L = helper(v.Len()); Print(L); }
`;
    const mod = compileMql5ToIR(src, { name: 'recover' });
    // Class V kept Len() (the operator was skipped).
    const v = (mod.classes ?? []).find((c) => c.name === 'V');
    expect(v).toBeDefined();
    expect(v!.methods.map((m) => m.name)).toContain('Len');
    expect(v!.methods.map((m) => m.name)).not.toContain('operator+');
    // The free function + the event handler survived.
    expect(mod.functions.map((f) => f.name)).toContain('helper');
    expect(mod.events.OnTick).toBe('OnTick');
    // And the construct was reported.
    expect((mod.diagnostics ?? []).some((d) => d.code === 'MQL_UNSUPPORTED_CONSTRUCT')).toBe(true);
  });

  it('does NOT false-positive on a global whose INITIALIZER uses scope resolution (::)', () => {
    // A legitimate global initialised via enum/scope resolution carries a `::`
    // in its INITIALIZER, not in the declaration head — it must NOT be mistaken
    // for an out-of-line definition (which would wrongly skip the global).
    const src = `
enum Color { Red = 1, Green = 2 };
Color g_c = Color::Green;
double g_buf[Color::Green];
void OnTick(){ }
`;
    const mod = compileMql5ToIR(src, { name: 'scopeinit' });
    expect((mod.diagnostics ?? []).some((d) => d.code === 'MQL_UNSUPPORTED_CONSTRUCT')).toBe(false);
    // The global declarations survived (not skipped).
    expect(mod.globals.map((g) => g.name)).toEqual(expect.arrayContaining(['g_c', 'g_buf']));
  });

  it('an out-of-line CONSTRUCTOR definition does not throw and is flagged', () => {
    const src = `
class CFoo {
public:
  CFoo();
  int y;
};
CFoo::CFoo(){ this.y = 0; }
void OnTick(){ }
`;
    expect(() => compileMql5ToIR(src, { name: 'oolctor' })).not.toThrow();
    expect(codesFor(diagnose(src), 'MQL_UNSUPPORTED_CONSTRUCT').length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Stdlib-class landmine — unimplemented flagged, implemented covered
// ─────────────────────────────────────────────────────────────────────────

describe('FIX 3 — unimplemented stdlib classes are flagged; implemented ones are covered', () => {
  it('flags a used-but-unimplemented stdlib class (CiMA)', () => {
    const src = `
int OnInit(){
   CiMA ma;
   return(INIT_SUCCEEDED);
}
`;
    const mod = compileMql5ToIR(src, { name: 'cima' });
    const coverage = checkCoverage(mod);
    const d = coverage.find((x) => x.symbol === 'CiMA');
    expect(d).toBeDefined();
    expect(d!.code).toBe('MQL_UNIMPLEMENTED_BUILTIN');
    expect(d!.severity).toBe('error');
  });

  it('does NOT flag the implemented stdlib classes (CPositionInfo/CSymbolInfo/CAccountInfo)', () => {
    const src = `
void OnTick(){
   CPositionInfo pos;
   CSymbolInfo   sym;
   CAccountInfo  acc;
   if(pos.Select(_Symbol)){ double v = pos.Volume(); }
   double bid = sym.Bid();
   double bal = acc.Balance();
}
`;
    const mod = compileMql5ToIR(src, { name: 'stdlibimpl' });
    const coverage = checkCoverage(mod);
    expect(coverage, JSON.stringify(coverage, null, 2)).toHaveLength(0);
  });

  it('flags several unimplemented stdlib classes when used together', () => {
    const src = `
int OnInit(){
   CArrayObj objs;
   CiRSI     r;
   return(INIT_SUCCEEDED);
}
`;
    const mod = compileMql5ToIR(src, { name: 'multi' });
    const symbols = checkCoverage(mod)
      .filter((d) => d.code === 'MQL_UNIMPLEMENTED_BUILTIN')
      .map((d) => d.symbol)
      .sort();
    expect(symbols).toEqual(['CArrayObj', 'CiRSI']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. OrderSend TRADE_ACTION_SLTP keys on request.position (the ticket)
// ─────────────────────────────────────────────────────────────────────────

/** A broker that records modifyPosition(symbol, sl, tp) calls. */
class RecordingBroker implements IBroker {
  public modifyCalls: { symbol: string; sl: number; tp: number }[] = [];
  constructor(private readonly open: Position[]) {}

  async placeMarketOrder(_req: OrderRequest): Promise<TradeResult> {
    throw new Error('not used');
  }
  async modifyPosition(symbol: string, sl: number, tp: number): Promise<TradeResult> {
    this.modifyCalls.push({ symbol, sl, tp });
    return {
      retcode: MQL_CONST.TRADE_RETCODE_DONE,
      ok: true,
      deal: 0,
      order: 0,
      position: 0,
      price: 0,
      volume: 0,
      comment: '',
    };
  }
  async closePosition(): Promise<TradeResult> {
    throw new Error('not used');
  }
  getPosition(symbol: string): Position | null {
    return this.open.find((p) => p.symbol === symbol) ?? null;
  }
  positions(): readonly Position[] {
    return this.open;
  }
  account(): AccountInfo {
    throw new Error('not used');
  }
}

function makePosition(over: Partial<Position> = {}): Position {
  return {
    ticket: 55667788,
    symbol: 'GBPUSD',
    side: 'buy',
    volume: 0.3,
    openPrice: 1.25,
    openTime: 1_000_000,
    sl: 0,
    tp: 0,
    profit: 0,
    swap: 0,
    magic: 0,
    comment: '',
    ...over,
  };
}

describe('FIX 4 — OrderSend TRADE_ACTION_SLTP keys on request.position (ticket), not request.symbol', () => {
  const TRADE_ACTION_SLTP = MQL_CONST.TRADE_ACTION_SLTP;
  const DONE = MQL_CONST.TRADE_RETCODE_DONE;

  it('resolves the position by request.position and modifies ITS symbol', async () => {
    // The open position is on GBPUSD (ticket 55667788). The request carries a
    // DIFFERENT/empty symbol but the correct position ticket — MT5 keys on the
    // ticket, so modifyPosition must run on GBPUSD (the ticket's symbol).
    const pos = makePosition({ ticket: 55667788, symbol: 'GBPUSD' });
    const broker = new RecordingBroker([pos]);

    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_SLTP;
    req.position = 55667788;
    req.symbol = ''; // deliberately NOT the position's symbol
    req.sl = 1.24;
    req.tp = 1.27;
    const res = new MqlTradeResult();

    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(res.retcode).toBe(DONE);
    expect(broker.modifyCalls).toHaveLength(1);
    expect(broker.modifyCalls[0]).toEqual({ symbol: 'GBPUSD', sl: 1.24, tp: 1.27 });
  });

  it('rejects honestly when the position ticket matches no open position', async () => {
    const broker = new RecordingBroker([makePosition({ ticket: 1 })]);
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_SLTP;
    req.position = 99999; // no such position
    req.symbol = 'GBPUSD';
    req.sl = 1.24;
    req.tp = 1.27;
    const res = new MqlTradeResult();

    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(false);
    expect(res.retcode).not.toBe(DONE);
    expect(broker.modifyCalls).toHaveLength(0); // never modified the wrong position
  });

  it('falls back to request.symbol when no position ticket is supplied', async () => {
    // Some EAs on a netting account fill only the symbol (symbol ⇒ the position).
    const pos = makePosition({ ticket: 7, symbol: 'EURUSD' });
    const broker = new RecordingBroker([pos]);
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_SLTP;
    req.position = 0; // §29 — 0 = "not specified" (a ticket is never 0)
    req.symbol = 'EURUSD';
    req.sl = 1.09;
    req.tp = 1.12;
    const res = new MqlTradeResult();

    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(broker.modifyCalls[0]!.symbol).toBe('EURUSD');
  });
});
