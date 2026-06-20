/**
 * AGENT READS tests — the order pool, closed-deal history, copies, and
 * symbol/account/time reads.
 *
 *  (a) Order pool: OrdersTotal / OrderGetTicket(index) (selects) / OrderSelect /
 *      OrderGetInteger/Double/String against a mock IBroker with 2 pending
 *      orders. Plus the §21 honest path: an egress WITHOUT pendingOrders →
 *      OrdersTotal()===0, OrderSelect()===false.
 *  (b) PositionGetTicket(index) over broker.positions().
 *  (c) History: HistorySelect(from,to) windows a mock deal log INCLUSIVELY;
 *      HistoryDealsTotal counts the window; HistoryDealGet* read by ticket;
 *      the §21 honest empty window when dealHistory is absent.
 *  (d) Copies: CopyRates fills dest with MqlRates structs in as-series order
 *      (newest-first) AND non-as-series order (oldest-first); CopyTickVolume /
 *      CopySpread per-field.
 *  (e) Reads: SymbolInfoString(name), SymbolSelect, AccountInfoString(currency),
 *      TimeGMT/TimeTradeServer, TimeToStruct on a known epoch.
 *  (f) The backtest broker's dealHistory() maps its recorded deals onto
 *      DealRecord and feeds HistoryState end-to-end.
 *
 * Run: npx vitest run test/reads.test.ts
 */

import { describe, it, expect } from 'vitest';
import type {
  AccountInfo,
  Bar,
  DealRecord,
  IBroker,
  IClock,
  IMarketFeed,
  OrderRequest,
  PendingOrder,
  Position,
  SymbolSpec,
  Tick,
  TradeResult,
} from '../src/runtime/providers/types';
import { OrderState, OrderProp, positionGetTicket } from '../src/runtime/orders';
import { HistoryState, DealProp } from '../src/runtime/history';
import {
  copyRates,
  copyTickVolume,
  copySpread,
  symbolInfoString,
  symbolSelect,
  accountInfoString,
  timeGMT,
  timeTradeServer,
  timeToStruct,
  SymbolStringProp,
  AccountStringProp,
  type MqlRates,
  type MqlDateTime,
} from '../src/runtime/reads';
import { ArraySeriesRegistry } from '../src/runtime/arrays';
import { BacktestBroker } from '../src/runtime/providers/backtest/broker';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

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

function bar(
  time: number,
  o: number,
  h: number,
  l: number,
  c: number,
  tickVol: number,
  spread: number,
  realVol: number,
): Bar {
  return { time, open: o, high: h, low: l, close: c, tickVolume: tickVol, spread, realVolume: realVol };
}

/** Three chronological bars (oldest → newest). */
const BARS: Bar[] = [
  bar(1_000_000, 1.10, 1.11, 1.09, 1.105, 10, 2, 100),
  bar(1_000_060, 1.105, 1.115, 1.10, 1.112, 20, 3, 200),
  bar(1_000_120, 1.112, 1.12, 1.11, 1.118, 30, 4, 300),
];

class MockFeed implements IMarketFeed {
  history(): readonly Bar[] {
    return BARS;
  }
  tick(): Tick {
    return { time: 1_000_120, bid: 1.118, ask: 1.119, last: 1.118, volume: 1 };
  }
  symbolInfo(): SymbolSpec {
    return SPEC;
  }
}

class MockClock implements IClock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
}

/** A mock broker exposing 2 pending orders + a deal log + an account. */
function makePending(ticket: number, kind: PendingOrder['kind'], price: number, extra: Partial<PendingOrder> = {}): PendingOrder {
  return {
    ticket,
    symbol: 'EURUSD',
    kind,
    volume: 0.10,
    price,
    sl: 0,
    tp: 0,
    placedTime: 1_000_000 + ticket,
    magic: 555,
    comment: `pend${ticket}`,
    ...extra,
  };
}

class MockBroker implements IBroker {
  private readonly pends: PendingOrder[];
  private readonly poss: Position[];
  private readonly deals: DealRecord[];
  constructor(opts: { pendings?: PendingOrder[]; positions?: Position[]; deals?: DealRecord[]; withPending?: boolean; withHistory?: boolean }) {
    this.pends = opts.pendings ?? [];
    this.poss = opts.positions ?? [];
    this.deals = opts.deals ?? [];
    // Optionally strip the OPTIONAL methods to test the §21 honest fallbacks.
    if (opts.withPending === false) {
      // delete the optional pending accessors
      (this as { pendingOrders?: unknown }).pendingOrders = undefined;
      (this as { getPendingOrder?: unknown }).getPendingOrder = undefined;
    }
    if (opts.withHistory === false) {
      (this as { dealHistory?: unknown }).dealHistory = undefined;
    }
  }
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
    return this.poss.find((p) => p.symbol === symbol) ?? null;
  }
  positions(): readonly Position[] {
    return this.poss;
  }
  account(): AccountInfo {
    return { login: 777, currency: 'EUR', leverage: 200, balance: 1000, equity: 1000, margin: 0, freeMargin: 1000 };
  }
  pendingOrders?(): readonly PendingOrder[] {
    return this.pends;
  }
  getPendingOrder?(ticket: number): PendingOrder | null {
    return this.pends.find((p) => p.ticket === ticket) ?? null;
  }
  dealHistory?(): readonly DealRecord[] {
    return this.deals;
  }
}

function deal(ticket: number, time: number, kind: 'open' | 'close', side: 'buy' | 'sell', profit: number, extra: Partial<DealRecord> = {}): DealRecord {
  return {
    ticket,
    order: ticket * 10,
    time,
    symbol: 'EURUSD',
    side,
    entry: kind,
    volume: 0.10,
    price: 1.10,
    profit,
    commission: 0,
    swap: 0,
    comment: `deal${ticket}`,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// (a) Order pool
// ─────────────────────────────────────────────────────────────────────────

describe('order pool — OrdersTotal / OrderGetTicket / OrderSelect / OrderGet*', () => {
  const pendings = [
    makePending(101, 'buyLimit', 1.0900),
    makePending(202, 'sellStop', 1.1300, { volume: 0.25, sl: 1.14, tp: 1.12 }),
  ];
  const broker = new MockBroker({ pendings });
  const orders = new OrderState(broker);

  it('OrdersTotal counts resting pendings', () => {
    expect(orders.total()).toBe(2);
  });

  it('OrderGetTicket(index) returns the ticket AND selects it', () => {
    expect(orders.getTicket(0)).toBe(101);
    // selected is now order 101 → OrderGet* read it
    expect(orders.getInteger(OrderProp.ORDER_TICKET)).toBe(101);
    expect(orders.getInteger(OrderProp.ORDER_TYPE)).toBe(2); // ORDER_TYPE_BUY_LIMIT
    expect(orders.getDouble(OrderProp.ORDER_PRICE_OPEN)).toBeCloseTo(1.0900, 10);

    expect(orders.getTicket(1)).toBe(202);
    expect(orders.getInteger(OrderProp.ORDER_TICKET)).toBe(202);
    expect(orders.getInteger(OrderProp.ORDER_TYPE)).toBe(5); // ORDER_TYPE_SELL_STOP
    expect(orders.getDouble(OrderProp.ORDER_VOLUME_CURRENT)).toBeCloseTo(0.25, 10);
    expect(orders.getDouble(OrderProp.ORDER_SL)).toBeCloseTo(1.14, 10);
    expect(orders.getDouble(OrderProp.ORDER_TP)).toBeCloseTo(1.12, 10);
  });

  it('OrderGetTicket out-of-range returns 0 and clears the selection', () => {
    expect(orders.getTicket(5)).toBe(0);
    expect(orders.current()).toBeNull();
    // reads on a null selection return the empty value, not throw
    expect(orders.getInteger(OrderProp.ORDER_TICKET)).toBe(0);
    expect(orders.getString(OrderProp.ORDER_COMMENT)).toBe('');
  });

  it('OrderSelect(ticket) selects by ticket; OrderGetString reads it', () => {
    expect(orders.select(202)).toBe(true);
    expect(orders.getString(OrderProp.ORDER_SYMBOL)).toBe('EURUSD');
    expect(orders.getString(OrderProp.ORDER_COMMENT)).toBe('pend202');
    expect(orders.getInteger(OrderProp.ORDER_MAGIC)).toBe(555);
    expect(orders.getInteger(OrderProp.ORDER_TIME_SETUP)).toBe(1_000_202);
    // a resting pending has no position id yet (§29: 0 is the real value)
    expect(orders.getInteger(OrderProp.ORDER_POSITION_ID)).toBe(0);
  });

  it('OrderSelect for an unknown ticket returns false', () => {
    expect(orders.select(9999)).toBe(false);
    expect(orders.current()).toBeNull();
  });

  it('stop-limit second price reads via ORDER_PRICE_STOPLIMIT; 0 when none', () => {
    const sl = new OrderState(
      new MockBroker({ pendings: [makePending(303, 'buyStopLimit', 1.20, { stopLimitPrice: 1.19 })] }),
    );
    expect(sl.getTicket(0)).toBe(303);
    expect(sl.getDouble(OrderProp.ORDER_PRICE_STOPLIMIT)).toBeCloseTo(1.19, 10);
    // a plain limit has no stop-limit price → honest 0
    expect(orders.select(101)).toBe(true);
    expect(orders.getDouble(OrderProp.ORDER_PRICE_STOPLIMIT)).toBe(0);
  });

  it('§21 honest fallback: an egress WITHOUT pendingOrders reports 0 / false', () => {
    const noPend = new OrderState(new MockBroker({ withPending: false }));
    expect(noPend.total()).toBe(0);
    expect(noPend.getTicket(0)).toBe(0);
    expect(noPend.select(101)).toBe(false);
  });

  it('OrderGetDouble(ORDER_PRICE_CURRENT) is honestly unsupported (throws)', () => {
    orders.select(101);
    expect(() => orders.getDouble(OrderProp.ORDER_PRICE_CURRENT)).toThrow(/ORDER_PRICE_CURRENT/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) PositionGetTicket
// ─────────────────────────────────────────────────────────────────────────

describe('PositionGetTicket(index)', () => {
  const positions: Position[] = [
    {
      ticket: 7001,
      symbol: 'EURUSD',
      side: 'buy',
      volume: 0.5,
      openPrice: 1.1,
      openTime: 1_000_000,
      sl: 0,
      tp: 0,
      profit: 0,
      swap: 0,
      magic: 1,
      comment: '',
    },
  ];
  const broker = new MockBroker({ positions });
  it('returns the ticket of the position at index', () => {
    expect(positionGetTicket(broker, 0)).toBe(7001);
  });
  it('returns 0 on out-of-range', () => {
    expect(positionGetTicket(broker, 1)).toBe(0);
    expect(positionGetTicket(broker, -1)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) History
// ─────────────────────────────────────────────────────────────────────────

describe('history — HistorySelect / HistoryDealsTotal / HistoryDealGet*', () => {
  const deals = [
    deal(1, 1_000_000, 'open', 'buy', 0),
    deal(2, 1_000_100, 'close', 'sell', 12.5),
    deal(3, 1_000_200, 'open', 'sell', 0),
    deal(4, 1_000_300, 'close', 'buy', -4.0),
  ];
  const broker = new MockBroker({ deals });
  const hist = new HistoryState(broker);

  it('HistorySelect windows the deal log INCLUSIVELY and returns true', () => {
    expect(hist.select(1_000_100, 1_000_200)).toBe(true);
    expect(hist.dealsTotal()).toBe(2); // deals 2 and 3 (boundaries inclusive)
  });

  it('a window with no deals is a SUCCESSFUL empty select (§29)', () => {
    expect(hist.select(2_000_000, 2_000_100)).toBe(true);
    expect(hist.dealsTotal()).toBe(0);
  });

  it('full window selects all deals', () => {
    expect(hist.select(0, 9_999_999)).toBe(true);
    expect(hist.dealsTotal()).toBe(4);
  });

  it('HistoryDealGetTicket / HistoryDealGetInteger / Double / String', () => {
    hist.select(0, 9_999_999);
    expect(hist.dealGetTicket(1)).toBe(2);
    expect(hist.dealGetInteger(2, DealProp.DEAL_TICKET)).toBe(2);
    expect(hist.dealGetInteger(2, DealProp.DEAL_ORDER)).toBe(20);
    expect(hist.dealGetInteger(2, DealProp.DEAL_TIME)).toBe(1_000_100);
    expect(hist.dealGetInteger(2, DealProp.DEAL_TYPE)).toBe(1); // sell
    expect(hist.dealGetInteger(2, DealProp.DEAL_ENTRY)).toBe(1); // close = OUT
    expect(hist.dealGetInteger(1, DealProp.DEAL_TYPE)).toBe(0); // buy
    expect(hist.dealGetInteger(1, DealProp.DEAL_ENTRY)).toBe(0); // open = IN
    expect(hist.dealGetDouble(2, DealProp.DEAL_PROFIT)).toBeCloseTo(12.5, 10);
    expect(hist.dealGetDouble(4, DealProp.DEAL_PROFIT)).toBeCloseTo(-4.0, 10);
    expect(hist.dealGetString(2, DealProp.DEAL_SYMBOL)).toBe('EURUSD');
    expect(hist.dealGetString(2, DealProp.DEAL_COMMENT)).toBe('deal2');
  });

  it('reversed window (from>to) selects nothing (MT5 behaviour)', () => {
    expect(hist.select(1_000_300, 1_000_000)).toBe(true);
    expect(hist.dealsTotal()).toBe(0);
  });

  it('a deal outside the selected window reads as empty (0 / "")', () => {
    hist.select(1_000_100, 1_000_100); // only deal 2
    expect(hist.dealGetInteger(1, DealProp.DEAL_TICKET)).toBe(0);
    expect(hist.dealGetString(1, DealProp.DEAL_SYMBOL)).toBe('');
  });

  it('§21 honest empty window when the egress records no deal log', () => {
    const noHist = new HistoryState(new MockBroker({ withHistory: false }));
    expect(noHist.select(0, 9_999_999)).toBe(true);
    expect(noHist.dealsTotal()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d) Copies — as-series ordering, per-field
// ─────────────────────────────────────────────────────────────────────────

describe('copies — CopyRates / CopyTickVolume / CopySpread (as-series aware)', () => {
  const feed = new MockFeed();

  it('CopyRates non-as-series fills oldest-first MqlRates structs', () => {
    const reg = new ArraySeriesRegistry();
    const dest: MqlRates[] = [];
    const n = copyRates(feed, reg, 'EURUSD', 0, 0, 3, dest);
    expect(n).toBe(3);
    // oldest-first: dest[0] = oldest bar (time 1_000_000)
    expect(dest[0]!.time).toBe(1_000_000);
    expect(dest[2]!.time).toBe(1_000_120);
    // struct fields mapped with MQL5 names
    expect(dest[2]!.close).toBeCloseTo(1.118, 10);
    expect(dest[2]!.tick_volume).toBe(30);
    expect(dest[2]!.real_volume).toBe(300);
    expect(dest[2]!.spread).toBe(4);
    expect(dest[2]!.open).toBeCloseTo(1.112, 10);
    expect(dest[2]!.high).toBeCloseTo(1.12, 10);
    expect(dest[2]!.low).toBeCloseTo(1.11, 10);
  });

  it('CopyRates as-series fills newest-first (dest[0] = current bar)', () => {
    const reg = new ArraySeriesRegistry();
    const dest: MqlRates[] = [];
    reg.setAsSeries(dest, true);
    const n = copyRates(feed, reg, 'EURUSD', 0, 0, 3, dest);
    expect(n).toBe(3);
    // newest-first: dest[0] = current bar (time 1_000_120)
    expect(dest[0]!.time).toBe(1_000_120);
    expect(dest[2]!.time).toBe(1_000_000);
  });

  it('CopyRates with startPos=1 skips the current bar', () => {
    const reg = new ArraySeriesRegistry();
    const dest: MqlRates[] = [];
    reg.setAsSeries(dest, true);
    const n = copyRates(feed, reg, 'EURUSD', 0, 1, 2, dest);
    expect(n).toBe(2);
    // startPos 1 (as-series) = the bar before current → time 1_000_060 newest-first
    expect(dest[0]!.time).toBe(1_000_060);
    expect(dest[1]!.time).toBe(1_000_000);
  });

  it('CopyRates count beyond history clamps to available bars', () => {
    const reg = new ArraySeriesRegistry();
    const dest: MqlRates[] = [];
    const n = copyRates(feed, reg, 'EURUSD', 0, 0, 100, dest);
    expect(n).toBe(3);
    expect(dest.length).toBe(3);
  });

  it('CopyRates invalid args (count<=0 / startPos<0) return 0', () => {
    const reg = new ArraySeriesRegistry();
    const d1: MqlRates[] = [];
    expect(copyRates(feed, reg, 'EURUSD', 0, 0, 0, d1)).toBe(0);
    const d2: MqlRates[] = [];
    expect(copyRates(feed, reg, 'EURUSD', 0, -1, 3, d2)).toBe(0);
  });

  it('CopyTickVolume / CopySpread per-field, as-series aware', () => {
    const reg = new ArraySeriesRegistry();
    const tv: number[] = [];
    reg.setAsSeries(tv, true);
    expect(copyTickVolume(feed, reg, 'EURUSD', 0, 0, 3, tv)).toBe(3);
    expect(tv).toEqual([30, 20, 10]); // newest-first

    const sp: number[] = [];
    expect(copySpread(feed, reg, 'EURUSD', 0, 0, 3, sp)).toBe(3);
    expect(sp).toEqual([2, 3, 4]); // oldest-first (not as-series)
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (e) Symbol / Account / Time reads
// ─────────────────────────────────────────────────────────────────────────

describe('symbol / account / time reads', () => {
  const feed = new MockFeed();
  const broker = new MockBroker({});

  it('SymbolInfoString returns the symbol name', () => {
    expect(symbolInfoString(feed, 'EURUSD', SymbolStringProp.SYMBOL_NAME)).toBe('EURUSD');
    expect(symbolInfoString(feed, 'EURUSD', SymbolStringProp.SYMBOL_DESCRIPTION)).toBe('EURUSD');
  });

  it('SymbolInfoString returns "" (not a crash, not a faked value) for an uncarried property (§21/§29)', () => {
    // An empty string is the honest "not carried" answer — it must NOT throw
    // (crashing a benign EA read) and must NOT fabricate a currency code.
    expect(symbolInfoString(feed, 'EURUSD', SymbolStringProp.SYMBOL_CURRENCY_BASE)).toBe('');
  });

  it('SymbolSelect succeeds for a known symbol; false=remove is a no-op success', () => {
    expect(symbolSelect(feed, 'EURUSD', true)).toBe(true);
    expect(symbolSelect(feed, 'EURUSD', false)).toBe(true);
  });

  it('AccountInfoString returns the account currency', () => {
    expect(accountInfoString(broker, AccountStringProp.ACCOUNT_CURRENCY)).toBe('EUR');
  });

  it('AccountInfoString returns backtest-context strings (no crash, no faked broker) (§21)', () => {
    // Synthetic but truthful backtest values — NOT a fabricated real-broker
    // identity. A benign EA read of server/company must not crash.
    expect(accountInfoString(broker, AccountStringProp.ACCOUNT_SERVER)).toBe('Backtest');
    expect(accountInfoString(broker, AccountStringProp.ACCOUNT_COMPANY)).toBe('mql5-transpiler');
    expect(accountInfoString(broker, AccountStringProp.ACCOUNT_NAME)).toBe('');
  });

  it('TimeGMT / TimeTradeServer return the clock time', () => {
    const clock = new MockClock(1_700_000_000);
    expect(timeGMT(clock)).toBe(1_700_000_000);
    expect(timeTradeServer(clock)).toBe(1_700_000_000);
  });

  it('TimeToStruct decomposes a known epoch (UTC)', () => {
    // 2021-01-01 00:00:00 UTC = 1609459200. Friday. day_of_year 0 (Jan 1).
    const out = {} as MqlDateTime;
    expect(timeToStruct(1609459200, out)).toBe(true);
    expect(out.year).toBe(2021);
    expect(out.mon).toBe(1);
    expect(out.day).toBe(1);
    expect(out.hour).toBe(0);
    expect(out.min).toBe(0);
    expect(out.sec).toBe(0);
    expect(out.day_of_week).toBe(5); // Friday (0=Sunday)
    expect(out.day_of_year).toBe(0); // Jan 1 == 0 (MT5 convention)
  });

  it('TimeToStruct on a mid-year datetime with time-of-day', () => {
    // 2021-07-04 13:37:45 UTC. Sunday. day_of_year = 184 (0-based: 31+28+31+30+31+30+3).
    const out = {} as MqlDateTime;
    // 2021-07-04 13:37:45 UTC epoch:
    const epoch = Date.UTC(2021, 6, 4, 13, 37, 45) / 1000;
    expect(timeToStruct(epoch, out)).toBe(true);
    expect(out.year).toBe(2021);
    expect(out.mon).toBe(7);
    expect(out.day).toBe(4);
    expect(out.hour).toBe(13);
    expect(out.min).toBe(37);
    expect(out.sec).toBe(45);
    expect(out.day_of_week).toBe(0); // 2021-07-04 was a Sunday
    // Jan(31)+Feb(28)+Mar(31)+Apr(30)+May(31)+Jun(30) = 181 days before July;
    // July 4 is the 4th of July → 0-based day_of_year = 181 + (4-1) = 184.
    expect(out.day_of_year).toBe(184);
  });

  it('TimeToStruct rejects a non-finite datetime', () => {
    const out = {} as MqlDateTime;
    expect(timeToStruct(Number.NaN, out)).toBe(false);
    expect(timeToStruct(Number.POSITIVE_INFINITY, out)).toBe(false);
  });

  it('TimeToStruct truncates fractional seconds', () => {
    const out = {} as MqlDateTime;
    expect(timeToStruct(1609459200.9, out)).toBe(true);
    expect(out.sec).toBe(0); // .9s truncated → still 00:00:00
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (f) End-to-end: BacktestBroker.dealHistory() → HistoryState
// ─────────────────────────────────────────────────────────────────────────

describe('BacktestBroker.dealHistory() feeds HistoryState end-to-end', () => {
  it('records open + close deals and HistorySelect reads them', async () => {
    let t = 1_000_000;
    let bid = 1.10;
    let ask = 1.101;
    const broker = new BacktestBroker({
      symbol: 'EURUSD',
      spec: SPEC,
      initialBalance: 10_000,
      priceFn: () => ({ bid, ask }),
      timeFn: () => t,
    });

    // Open a buy at ask.
    broker.mark(bid, ask);
    const open = await broker.placeMarketOrder({ symbol: 'EURUSD', side: 'buy', volume: 0.10 });
    expect(open.ok).toBe(true);

    // Advance time + price, then close for a profit.
    t = 1_000_060;
    bid = 1.12;
    ask = 1.121;
    broker.mark(bid, ask);
    const close = await broker.closePosition('EURUSD');
    expect(close.ok).toBe(true);

    // dealHistory exposes 2 DealRecords (open + close), chronological.
    const dh = broker.dealHistory();
    expect(dh.length).toBe(2);
    expect(dh[0]!.entry).toBe('open');
    expect(dh[1]!.entry).toBe('close');
    expect(dh[1]!.profit).toBeGreaterThan(0);

    // HistoryState reads them via the IBroker boundary.
    const hist = new HistoryState(broker);
    expect(hist.select(0, 9_999_999)).toBe(true);
    expect(hist.dealsTotal()).toBe(2);
    const closeTicket = dh[1]!.ticket;
    expect(hist.dealGetInteger(closeTicket, DealProp.DEAL_ENTRY)).toBe(1); // OUT
    expect(hist.dealGetDouble(closeTicket, DealProp.DEAL_PROFIT)).toBeCloseTo(dh[1]!.profit, 8);
    // a window before any deal selects nothing
    expect(hist.select(0, 999_999)).toBe(true);
    expect(hist.dealsTotal()).toBe(0);
  });
});
