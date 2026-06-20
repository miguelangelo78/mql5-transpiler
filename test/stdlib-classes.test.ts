/**
 * Standard-Library info-class tests (CPositionInfo / CSymbolInfo / CAccountInfo).
 *
 * These three thin OO wrappers (under src/runtime/stdlib) delegate to the
 * PositionGet / SymbolInfo / AccountInfo builtins over the provider boundary.
 * We prove:
 *   (a) the runtime REGISTERS them — `new rt.CPositionInfo(rt)` etc. construct
 *       (the emission ABI the backend uses: `new rt.<Class>(rt)`), so an EA's
 *       bare `CPositionInfo pos;` won't be a `null` landmine;
 *   (b) each accessor returns the value the underlying builtin returns over a
 *       mock broker/feed — i.e. the wrapper is a faithful pass-through, not a
 *       re-implementation that could drift.
 *
 * The mock providers mirror test/runtime.test.ts so the wrappers are exercised
 * over the exact same boundary the engine uses.
 */

import { describe, expect, it } from 'vitest';

import { createRuntime } from '../src/runtime/index';
import { MQL_CONST } from '../src/runtime/constants';
import type {
  AccountInfo,
  Bar,
  IBroker,
  IClock,
  IMarketFeed,
  OrderRequest,
  Position,
  Providers,
  SymbolSpec,
  Tick,
  TradeResult,
} from '../src/runtime/providers/types';
import type { Runtime } from '../src/runtime/runtime';

// ── mock providers (a small superset of test/runtime.test.ts's) ──

const SPEC: SymbolSpec = {
  name: 'EURUSD',
  digits: 5,
  point: 0.00001,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.5,
  contractSize: 100000,
  tickSize: 0.00001,
  tickValue: 7.5,
};

class MockFeed implements IMarketFeed {
  constructor(
    public bid = 1.10000,
    public ask = 1.10020,
  ) {}
  history(): readonly Bar[] {
    return [];
  }
  tick(): Tick {
    return { time: 1_000_000, bid: this.bid, ask: this.ask, last: this.bid, volume: 1 };
  }
  symbolInfo(): SymbolSpec {
    return SPEC;
  }
}

class MockClock implements IClock {
  now(): number {
    return 1_000_000;
  }
}

class MockBroker implements IBroker {
  public openPositions: Position[] = [];
  public acct: AccountInfo = {
    login: 778899,
    currency: 'USD',
    leverage: 200,
    balance: 0, // §29 — a 0 balance is a VALID account state, not a sentinel
    equity: 12.5,
    margin: 3.25,
    freeMargin: 9.25,
  };

  async placeMarketOrder(_req: OrderRequest): Promise<TradeResult> {
    throw new Error('not used');
  }
  async modifyPosition(): Promise<TradeResult> {
    throw new Error('not used');
  }
  async closePosition(): Promise<TradeResult> {
    throw new Error('not used');
  }
  getPosition(symbol: string): Position | null {
    return this.openPositions.find((p) => p.symbol === symbol) ?? null;
  }
  positions(): readonly Position[] {
    return this.openPositions;
  }
  account(): AccountInfo {
    return this.acct;
  }
}

function makeRuntime(): { rt: Runtime; broker: MockBroker; feed: MockFeed } {
  const feed = new MockFeed();
  const broker = new MockBroker();
  const clock = new MockClock();
  const providers: Providers = { feed, broker, clock };
  const rt = createRuntime(providers, { symbol: 'EURUSD', timeframe: MQL_CONST.PERIOD_M1 });
  return { rt, broker, feed };
}

function openPosition(broker: MockBroker, over: Partial<Position> = {}): Position {
  const pos: Position = {
    ticket: 42424242,
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.5,
    openPrice: 1.10005,
    openTime: 999_000,
    sl: 1.09800,
    tp: 1.10500,
    profit: 7.25,
    swap: -0.3,
    magic: 20240614,
    comment: 'unit-pos',
    ...over,
  };
  broker.openPositions.push(pos);
  return pos;
}

// ─────────────────────────────────────────────────────────────────────────
// CPositionInfo
// ─────────────────────────────────────────────────────────────────────────

describe('CPositionInfo — runtime-registered + faithful PositionGet* wrapper', () => {
  it('constructs via the runtime ctor (new rt.CPositionInfo(rt))', () => {
    const { rt } = makeRuntime();
    const pos = new rt.CPositionInfo(rt);
    expect(pos).toBeDefined();
    expect(typeof pos.Select).toBe('function');
  });

  it('Select(symbol) selects and the accessors read off the selection', () => {
    const { rt, broker } = makeRuntime();
    const p = openPosition(broker);
    const pos = new rt.CPositionInfo(rt);

    expect(pos.Select('EURUSD')).toBe(true);
    expect(pos.Symbol()).toBe('EURUSD');
    // POSITION_TYPE: buy → POSITION_TYPE_BUY (0).
    expect(pos.PositionType()).toBe(MQL_CONST.POSITION_TYPE_BUY);
    expect(pos.Volume()).toBe(p.volume);
    expect(pos.PriceOpen()).toBe(p.openPrice);
    expect(pos.StopLoss()).toBe(p.sl);
    expect(pos.TakeProfit()).toBe(p.tp);
    expect(pos.Profit()).toBe(p.profit);
    expect(pos.Swap()).toBe(p.swap);
    expect(pos.Magic()).toBe(p.magic);
    expect(pos.Comment()).toBe(p.comment);
    expect(pos.Ticket()).toBe(p.ticket);
    expect(pos.Time()).toBe(p.openTime);
  });

  it('Select on a missing symbol returns false', () => {
    const { rt, broker } = makeRuntime();
    openPosition(broker, { symbol: 'EURUSD' });
    const pos = new rt.CPositionInfo(rt);
    expect(pos.Select('GBPUSD')).toBe(false);
  });

  it('SelectByTicket selects by ticket across all open positions', () => {
    const { rt, broker } = makeRuntime();
    openPosition(broker, { ticket: 111, symbol: 'EURUSD' });
    openPosition(broker, { ticket: 222, symbol: 'GBPUSD', side: 'sell', volume: 1.0 });
    const pos = new rt.CPositionInfo(rt);

    expect(pos.SelectByTicket(222)).toBe(true);
    expect(pos.Ticket()).toBe(222);
    expect(pos.Symbol()).toBe('GBPUSD');
    expect(pos.PositionType()).toBe(MQL_CONST.POSITION_TYPE_SELL);
    expect(pos.SelectByTicket(999)).toBe(false);
  });

  it('a SELL position reports POSITION_TYPE_SELL', () => {
    const { rt, broker } = makeRuntime();
    openPosition(broker, { side: 'sell' });
    const pos = new rt.CPositionInfo(rt);
    pos.Select('EURUSD');
    expect(pos.PositionType()).toBe(MQL_CONST.POSITION_TYPE_SELL);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CSymbolInfo
// ─────────────────────────────────────────────────────────────────────────

describe('CSymbolInfo — runtime-registered + faithful SymbolInfo wrapper', () => {
  it('constructs via the runtime ctor and defaults Name() to the chart symbol', () => {
    const { rt } = makeRuntime();
    const sym = new rt.CSymbolInfo(rt);
    expect(sym.Name()).toBe('EURUSD');
  });

  it('Name(symbol) rebinds the symbol (and returns a bool)', () => {
    const { rt } = makeRuntime();
    const sym = new rt.CSymbolInfo(rt);
    const ok = sym.Name('GBPUSD');
    expect(typeof ok).toBe('boolean');
    expect(sym.Name()).toBe('GBPUSD');
  });

  it('Bid/Ask read the live tick; Point/Digits/Volume*/TickValue read the spec', () => {
    const { rt, feed } = makeRuntime();
    const sym = new rt.CSymbolInfo(rt);
    expect(sym.Bid()).toBe(feed.bid);
    expect(sym.Ask()).toBe(feed.ask);
    expect(sym.Point()).toBe(SPEC.point);
    expect(sym.Digits()).toBe(SPEC.digits);
    expect(sym.VolumeMin()).toBe(SPEC.volumeMin);
    expect(sym.VolumeMax()).toBe(SPEC.volumeMax);
    expect(sym.VolumeStep()).toBe(SPEC.volumeStep);
    expect(sym.TickValue()).toBe(SPEC.tickValue);
  });

  it('Spread() = round((ask - bid)/point) in points', () => {
    const { rt, feed } = makeRuntime();
    feed.bid = 1.10000;
    feed.ask = 1.10020; // 20 points at point=0.00001
    const sym = new rt.CSymbolInfo(rt);
    expect(sym.Spread()).toBe(20);
  });

  it('Spread() is 0 for a perfectly tight (zero-spread) market — §29', () => {
    const { rt, feed } = makeRuntime();
    feed.bid = 1.10000;
    feed.ask = 1.10000;
    const sym = new rt.CSymbolInfo(rt);
    expect(sym.Spread()).toBe(0);
  });

  it('Refresh()/RefreshRates() succeed (reads are live — nothing to stale)', () => {
    const { rt } = makeRuntime();
    const sym = new rt.CSymbolInfo(rt);
    expect(sym.Refresh()).toBe(true);
    expect(sym.RefreshRates()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CAccountInfo
// ─────────────────────────────────────────────────────────────────────────

describe('CAccountInfo — runtime-registered + faithful AccountInfo wrapper', () => {
  it('constructs via the runtime ctor', () => {
    const { rt } = makeRuntime();
    const acc = new rt.CAccountInfo(rt);
    expect(typeof acc.Balance).toBe('function');
  });

  it('reads login/leverage/balance/equity/margin/freeMargin/profit/currency', () => {
    const { rt, broker } = makeRuntime();
    const acc = new rt.CAccountInfo(rt);
    const a = broker.acct;

    expect(acc.Login()).toBe(a.login);
    expect(acc.Leverage()).toBe(a.leverage);
    // §29 — a balance of 0 must round-trip as 0, NOT be treated as absent.
    expect(acc.Balance()).toBe(0);
    expect(acc.Equity()).toBe(a.equity);
    expect(acc.Margin()).toBe(a.margin);
    expect(acc.FreeMargin()).toBe(a.freeMargin);
    // Profit() = equity - balance in the netting model (AccountInfoDouble PROFIT).
    expect(acc.Profit()).toBe(a.equity - a.balance);
    expect(acc.Currency()).toBe(a.currency);
  });

  it('a funded account reports its real (non-zero) balance', () => {
    const { rt, broker } = makeRuntime();
    broker.acct.balance = 9876.54;
    broker.acct.equity = 9999.99;
    const acc = new rt.CAccountInfo(rt);
    expect(acc.Balance()).toBe(9876.54);
    expect(acc.Profit()).toBeCloseTo(9999.99 - 9876.54, 6);
  });
});
