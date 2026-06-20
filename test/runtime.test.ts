/**
 * Runtime module tests (the load-bearing fidelity paths).
 *
 *  (a) SMA vs an INDEPENDENTLY hand-computed reference, incl. warm-up.
 *  (b) CopyBuffer as-series ordering (dest[0]===newest) AND non-as-series.
 *  (c) ArraySetAsSeries registry by ARRAY IDENTITY.
 *  (d) CTrade.Buy against a MOCK IBroker returns true and records the deal.
 *  (e) PositionSelect + PositionGetInteger(POSITION_TYPE) round-trip.
 *
 * Run: npx vitest run test/runtime.test.ts
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime/index';
import { computeSMA } from '../src/runtime/indicators/sma';
import { MQL_CONST } from '../src/runtime/constants';
import type {
  Bar,
  Tick,
  SymbolSpec,
  Position,
  TradeResult,
  OrderRequest,
  AccountInfo,
  IBroker,
  IMarketFeed,
  IClock,
  Providers,
} from '../src/runtime/providers/types';
import type { RuntimeContext } from '../src/engine/types';

// ─────────────────────────────────────────────────────────────────────────
// Mock providers
// ─────────────────────────────────────────────────────────────────────────

function bar(time: number, close: number): Bar {
  // open/high/low set so MEDIAN/TYPICAL math is exercisable; close is the
  // load-bearing field for PRICE_CLOSE SMA.
  return {
    time,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    tickVolume: 100,
    spread: 1,
    realVolume: 0,
  };
}

const SPEC: SymbolSpec = {
  name: 'EURUSD',
  digits: 5,
  point: 0.00001,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  contractSize: 100000,
  tickSize: 0.00001,
  tickValue: 1,
};

class MockFeed implements IMarketFeed {
  constructor(public bars: Bar[]) {}
  history(_symbol: string, _timeframe: number): readonly Bar[] {
    return this.bars;
  }
  tick(_symbol: string): Tick {
    const last = this.bars[this.bars.length - 1]!;
    return { time: last.time, bid: last.close, ask: last.close + 0.0001, last: last.close, volume: 1 };
  }
  symbolInfo(_symbol: string): SymbolSpec {
    return SPEC;
  }
}

class MockClock implements IClock {
  constructor(public t = 1_000_000) {}
  now(): number {
    return this.t;
  }
}

class MockBroker implements IBroker {
  public placed: OrderRequest[] = [];
  public openPositions: Position[] = [];
  private acct: AccountInfo = {
    login: 12345,
    currency: 'USD',
    leverage: 100,
    balance: 10000,
    equity: 10000,
    margin: 0,
    freeMargin: 10000,
  };
  private nextTicket = 1000;

  async placeMarketOrder(req: OrderRequest): Promise<TradeResult> {
    this.placed.push(req);
    const ticket = this.nextTicket++;
    this.openPositions.push({
      ticket,
      symbol: req.symbol,
      side: req.side,
      volume: req.volume,
      openPrice: req.price && req.price > 0 ? req.price : 1.1,
      openTime: 1_000_000,
      sl: req.sl ?? 0,
      tp: req.tp ?? 0,
      profit: 0,
      swap: 0,
      magic: req.magic ?? 0,
      comment: req.comment ?? '',
    });
    return {
      retcode: MQL_CONST.TRADE_RETCODE_DONE,
      ok: true,
      deal: ticket,
      order: ticket,
      position: ticket,
      price: req.price && req.price > 0 ? req.price : 1.1,
      volume: req.volume,
      comment: req.comment ?? '',
    };
  }
  async modifyPosition(symbol: string, sl: number, tp: number): Promise<TradeResult> {
    const p = this.openPositions.find((x) => x.symbol === symbol);
    if (p) {
      p.sl = sl;
      p.tp = tp;
    }
    return { retcode: MQL_CONST.TRADE_RETCODE_DONE, ok: true, deal: 0, order: 0, position: p?.ticket ?? 0, price: 0, volume: 0, comment: '' };
  }
  async closePosition(symbol: string, _volume?: number): Promise<TradeResult> {
    const idx = this.openPositions.findIndex((x) => x.symbol === symbol);
    if (idx >= 0) this.openPositions.splice(idx, 1);
    return { retcode: MQL_CONST.TRADE_RETCODE_DONE, ok: true, deal: 0, order: 0, position: 0, price: 0, volume: 0, comment: '' };
  }
  getPosition(symbol: string): Position | null {
    return this.openPositions.find((x) => x.symbol === symbol) ?? null;
  }
  positions(): readonly Position[] {
    return this.openPositions;
  }
  account(): AccountInfo {
    return this.acct;
  }
}

function makeRuntime(bars: Bar[], ctx?: Partial<RuntimeContext>) {
  const feed = new MockFeed(bars);
  const broker = new MockBroker();
  const clock = new MockClock();
  const providers: Providers = { feed, broker, clock };
  const rt = createRuntime(providers, {
    symbol: ctx?.symbol ?? 'EURUSD',
    timeframe: ctx?.timeframe ?? MQL_CONST.PERIOD_M1,
  });
  return { rt, feed, broker, clock };
}

// ─────────────────────────────────────────────────────────────────────────
// (a) SMA vs hand-computed reference incl. warm-up
// ─────────────────────────────────────────────────────────────────────────

describe('SMA fidelity (MT5 SimpleMA semantics)', () => {
  it('matches an independently hand-computed reference incl. warm-up nulls', () => {
    // close prices 1..6 at bars 0..5
    const closes = [1, 2, 3, 4, 5, 6];
    const bars = closes.map((c, i) => bar(1000 + i * 60, c));

    const period = 3;
    const series = computeSMA(bars, period, MQL_CONST.PRICE_CLOSE, 0);

    // Hand reference: first (period-1)=2 bars have NO value (null).
    // SMA[2] = (1+2+3)/3 = 2
    // SMA[3] = (2+3+4)/3 = 3
    // SMA[4] = (3+4+5)/3 = 4
    // SMA[5] = (4+5+6)/3 = 5
    expect(series).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('honours ma_shift by shifting the line forward', () => {
    const closes = [1, 2, 3, 4, 5, 6];
    const bars = closes.map((c, i) => bar(1000 + i * 60, c));
    // period 3, shift 1: value at bar i = base SMA at bar i-1.
    // base = [null,null,2,3,4,5] → shifted by 1 → [null,null,null,2,3,4]
    const series = computeSMA(bars, 3, MQL_CONST.PRICE_CLOSE, 1);
    expect(series).toEqual([null, null, null, 2, 3, 4]);
  });

  it('period equal to bar count yields exactly one value at the last bar', () => {
    const closes = [10, 20, 30, 40];
    const bars = closes.map((c, i) => bar(1000 + i * 60, c));
    const series = computeSMA(bars, 4, MQL_CONST.PRICE_CLOSE, 0);
    // only bar 3 has a value: mean(10,20,30,40)=25
    expect(series).toEqual([null, null, null, 25]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) CopyBuffer as-series + non-as-series ordering
// ─────────────────────────────────────────────────────────────────────────

describe('CopyBuffer ordering', () => {
  // closes 1..6 → SMA period 3 → chronological [.,.,2,3,4,5]
  const closes = [1, 2, 3, 4, 5, 6];
  const bars = closes.map((c, i) => bar(1000 + i * 60, c));

  it('as-series dest: dest[0] === newest', () => {
    const { rt } = makeRuntime(bars);
    const h = rt.iMA('EURUSD', MQL_CONST.PERIOD_M1, 3, 0, MQL_CONST.MODE_SMA, MQL_CONST.PRICE_CLOSE);
    expect(h).toBeGreaterThanOrEqual(0);

    const dest: number[] = [];
    rt.ArraySetAsSeries(dest, true);
    const n = rt.CopyBuffer(h, 0, 0, 3, dest);
    expect(n).toBe(3);
    // newest SMA is at chronological bar 5 = 5; going back: 4, 3.
    expect(dest[0]).toBe(5); // newest
    expect(dest[1]).toBe(4);
    expect(dest[2]).toBe(3);
  });

  it('non-as-series dest: dest[0] === oldest of the copied window', () => {
    const { rt } = makeRuntime(bars);
    const h = rt.iMA('EURUSD', MQL_CONST.PERIOD_M1, 3, 0, MQL_CONST.MODE_SMA, MQL_CONST.PRICE_CLOSE);
    const dest: number[] = [];
    // NOT marked as-series
    const n = rt.CopyBuffer(h, 0, 0, 3, dest);
    expect(n).toBe(3);
    // window newest→older is [5,4,3]; non-series reverses → [3,4,5]
    expect(dest[0]).toBe(3); // oldest of window
    expect(dest[1]).toBe(4);
    expect(dest[2]).toBe(5); // newest
  });

  it('returns fewer than requested when the window reaches warm-up', () => {
    const { rt } = makeRuntime(bars);
    const h = rt.iMA('EURUSD', MQL_CONST.PERIOD_M1, 3, 0, MQL_CONST.MODE_SMA, MQL_CONST.PRICE_CLOSE);
    const dest: number[] = [];
    rt.ArraySetAsSeries(dest, true);
    // request 6 values; only 4 SMA values exist (bars 2..5)
    const n = rt.CopyBuffer(h, 0, 0, 6, dest);
    expect(n).toBe(4);
    expect(dest).toEqual([5, 4, 3, 2]); // newest→older
  });

  it('iMA returns INVALID_HANDLE on non-positive period', () => {
    const { rt } = makeRuntime(bars);
    expect(rt.iMA('EURUSD', MQL_CONST.PERIOD_M1, 0, 0, MQL_CONST.MODE_SMA, MQL_CONST.PRICE_CLOSE)).toBe(
      MQL_CONST.INVALID_HANDLE,
    );
  });

  it('IndicatorRelease frees the handle', () => {
    const { rt } = makeRuntime(bars);
    const h = rt.iMA('EURUSD', MQL_CONST.PERIOD_M1, 3, 0, MQL_CONST.MODE_SMA, MQL_CONST.PRICE_CLOSE);
    expect(rt.IndicatorRelease(h)).toBe(true);
    expect(rt.IndicatorRelease(h)).toBe(false); // already gone
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) ArraySetAsSeries registry by identity
// ─────────────────────────────────────────────────────────────────────────

describe('as-series registry keyed by array identity', () => {
  it('tracks the flag per distinct array object', () => {
    const { rt } = makeRuntime([]);
    const a: number[] = [];
    const b: number[] = [];
    expect(rt.ArrayGetAsSeries(a)).toBe(false);
    expect(rt.ArrayGetAsSeries(b)).toBe(false);

    rt.ArraySetAsSeries(a, true);
    expect(rt.ArrayGetAsSeries(a)).toBe(true);
    // b is a DIFFERENT object → unaffected
    expect(rt.ArrayGetAsSeries(b)).toBe(false);

    rt.ArraySetAsSeries(a, false);
    expect(rt.ArrayGetAsSeries(a)).toBe(false);
  });

  it('a structurally-equal but distinct array is not the same identity', () => {
    const { rt } = makeRuntime([]);
    const a = [1, 2, 3];
    const aCopy = [1, 2, 3];
    rt.ArraySetAsSeries(a, true);
    expect(rt.ArrayGetAsSeries(a)).toBe(true);
    expect(rt.ArrayGetAsSeries(aCopy)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d) CTrade.Buy against a mock broker
// ─────────────────────────────────────────────────────────────────────────

describe('CTrade over the broker provider', () => {
  it('Buy returns true and records the deal on the broker', async () => {
    const { rt, broker } = makeRuntime([]);
    const trade = new rt.CTrade(rt);
    const ok = await trade.Buy(0.1, 'EURUSD');
    expect(ok).toBe(true);
    expect(broker.placed.length).toBe(1);
    expect(broker.placed[0]!.side).toBe('buy');
    expect(broker.placed[0]!.volume).toBe(0.1);
    expect(broker.placed[0]!.symbol).toBe('EURUSD');
    // last-result accessors reflect the deal
    expect(trade.ResultRetcode()).toBe(MQL_CONST.TRADE_RETCODE_DONE);
    expect(trade.ResultVolume()).toBe(0.1);
    expect(broker.positions().length).toBe(1);
    expect(broker.positions()[0]!.side).toBe('buy');
  });

  it('Buy defaults the symbol to _Symbol when omitted', async () => {
    const { rt, broker } = makeRuntime([], { symbol: 'GBPUSD' });
    const trade = new rt.CTrade(rt);
    const ok = await trade.Buy(0.2);
    expect(ok).toBe(true);
    expect(broker.placed[0]!.symbol).toBe('GBPUSD');
  });

  it('PositionClose closes the netting position by symbol', async () => {
    const { rt, broker } = makeRuntime([]);
    const trade = new rt.CTrade(rt);
    await trade.Sell(0.3, 'EURUSD');
    expect(broker.positions().length).toBe(1);
    const ok = await trade.PositionClose('EURUSD');
    expect(ok).toBe(true);
    expect(broker.positions().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (e) PositionSelect + PositionGetInteger(POSITION_TYPE) round-trip
// ─────────────────────────────────────────────────────────────────────────

describe('position selection + property reads', () => {
  it('PositionSelect then PositionGetInteger(POSITION_TYPE) round-trips a SELL', async () => {
    const { rt, broker } = makeRuntime([]);
    const trade = new rt.CTrade(rt);
    await trade.Sell(0.5, 'EURUSD');

    expect(rt.PositionSelect('EURUSD')).toBe(true);
    expect(rt.PositionGetInteger(MQL_CONST.POSITION_TYPE)).toBe(MQL_CONST.POSITION_TYPE_SELL);
    expect(rt.PositionGetDouble(MQL_CONST.POSITION_VOLUME)).toBe(0.5);
    expect(rt.PositionGetString(MQL_CONST.POSITION_SYMBOL)).toBe('EURUSD');

    // selecting a symbol with no position returns false
    expect(rt.PositionSelect('NOPE')).toBe(false);
  });

  it('PositionGetInteger(POSITION_TYPE) reads BUY correctly', async () => {
    const { rt } = makeRuntime([]);
    const trade = new rt.CTrade(rt);
    await trade.Buy(0.5, 'EURUSD');
    expect(rt.PositionSelect('EURUSD')).toBe(true);
    expect(rt.PositionGetInteger(MQL_CONST.POSITION_TYPE)).toBe(MQL_CONST.POSITION_TYPE_BUY);
    expect(rt.PositionsTotal()).toBe(1);
    expect(rt.PositionGetSymbol(0)).toBe('EURUSD');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// NormalizeDouble (used widely)
// ─────────────────────────────────────────────────────────────────────────

describe('NormalizeDouble', () => {
  it('rounds to the given digit count, half away from zero', () => {
    const { rt } = makeRuntime([]);
    expect(rt.NormalizeDouble(1.234567, 5)).toBe(1.23457);
    expect(rt.NormalizeDouble(1.2345649, 5)).toBe(1.23456);
    expect(rt.NormalizeDouble(2.5, 0)).toBe(3);
    expect(rt.NormalizeDouble(-2.5, 0)).toBe(-3);
    expect(rt.NormalizeDouble(0, 5)).toBe(0); // §29: 0 is a valid value
  });
});
