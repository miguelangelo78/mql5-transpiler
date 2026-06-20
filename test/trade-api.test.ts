/**
 * Trade-API runtime tests — the raw OrderSend primitive, the MqlTradeRequest /
 * MqlTradeResult structs, and the CTrade completion methods (PositionOpen,
 * OrderModify, config setters, extra Result* accessors).
 *
 * All against a MOCK IBroker (no engine, no real provider) that records every
 * call and returns DONE TradeResults — so we assert the dispatch + in-place
 * result mutation exactly, the way the MT5 builtin mutates its by-ref out-param.
 *
 * Constant values used here (the integrator must add these to constants.ts —
 * canonical MQL5 ENUM_TRADE_REQUEST_ACTIONS / ENUM_ORDER_TYPE values):
 *   TRADE_ACTION_DEAL=1 PENDING=5 SLTP=6 MODIFY=7 REMOVE=8 CLOSE_BY=10
 *   ORDER_TYPE_BUY=0 SELL=1 BUY_LIMIT=2 SELL_LIMIT=3 BUY_STOP=4 SELL_STOP=5
 *
 * Run: npx vitest run test/trade-api.test.ts
 */

import { describe, it, expect } from 'vitest';
import { orderSend } from '../src/runtime/orderSend';
import {
  MqlTradeRequest,
  MqlTradeResult,
  MqlTradeCheckResult,
  MqlTradeTransaction,
} from '../src/runtime/mqlStructs';
import { CTrade } from '../src/runtime/ctrade';
import { createRuntime } from '../src/runtime/index';
import { MQL_CONST } from '../src/runtime/constants';
import type {
  Bar,
  Tick,
  SymbolSpec,
  Position,
  PendingOrder,
  PendingOrderRequest,
  TradeResult,
  OrderRequest,
  AccountInfo,
  IBroker,
  IMarketFeed,
  IClock,
  Providers,
} from '../src/runtime/providers/types';
import type { Runtime } from '../src/runtime/runtime';
import type { RuntimeContext } from '../src/engine/types';

// Canonical action / order-type values (mirror constants.ts to-be-added).
const TRADE_ACTION_DEAL = 1;
const TRADE_ACTION_PENDING = 5;
const TRADE_ACTION_SLTP = 6;
const TRADE_ACTION_MODIFY = 7;
const TRADE_ACTION_REMOVE = 8;
const TRADE_ACTION_CLOSE_BY = 10;
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;
const ORDER_TYPE_BUY_LIMIT = 2;
const ORDER_TYPE_SELL_STOP = 5;
const DONE = 10009;
const INVALID = 10013;

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

function bar(time: number, close: number): Bar {
  return { time, open: close, high: close + 0.001, low: close - 0.001, close, tickVolume: 1, spread: 1, realVolume: 0 };
}

class MockFeed implements IMarketFeed {
  bars: Bar[] = [bar(1_000_000, 1.1), bar(1_000_060, 1.1005)];
  history(): readonly Bar[] {
    return this.bars;
  }
  tick(): Tick {
    return { time: 1_000_060, bid: 1.1005, ask: 1.1006, last: 1.1005, volume: 1 };
  }
  symbolInfo(): SymbolSpec {
    return SPEC;
  }
}

class MockClock implements IClock {
  now(): number {
    return 1_000_060;
  }
}

const ACCT: AccountInfo = {
  login: 1, currency: 'USD', leverage: 100, balance: 10000,
  equity: 10000, margin: 0, freeMargin: 10000,
};

/**
 * Full mock broker: records every call, returns DONE results with synthetic
 * tickets so we can assert in-place result filling. Implements the optional
 * pending methods so the supported-egress paths exercise.
 */
class MockBroker implements IBroker {
  public marketOrders: OrderRequest[] = [];
  public pendingPlaced: PendingOrderRequest[] = [];
  public modifiedPositions: Array<{ symbol: string; sl: number; tp: number }> = [];
  public modifiedPendings: Array<{ ticket: number; price: number; sl: number; tp: number }> = [];
  public deletedPendings: number[] = [];
  private nextTicket = 7000;

  async placeMarketOrder(req: OrderRequest): Promise<TradeResult> {
    this.marketOrders.push(req);
    const deal = this.nextTicket++;
    return {
      retcode: DONE, ok: true, deal, order: deal, position: deal,
      price: req.price && req.price > 0 ? req.price : 1.1006,
      volume: req.volume, comment: req.comment ?? 'done',
    };
  }
  async modifyPosition(symbol: string, sl: number, tp: number): Promise<TradeResult> {
    this.modifiedPositions.push({ symbol, sl, tp });
    return { retcode: DONE, ok: true, deal: 0, order: 0, position: 1, price: 0, volume: 0, comment: 'sltp' };
  }
  async closePosition(): Promise<TradeResult> {
    return { retcode: DONE, ok: true, deal: 0, order: 0, position: 0, price: 0, volume: 0, comment: '' };
  }
  getPosition(): Position | null {
    return null;
  }
  positions(): readonly Position[] {
    return [];
  }
  account(): AccountInfo {
    return ACCT;
  }
  async placePendingOrder(req: PendingOrderRequest): Promise<TradeResult> {
    this.pendingPlaced.push(req);
    const ticket = this.nextTicket++;
    return {
      retcode: DONE, ok: true, deal: 0, order: ticket, position: 0,
      price: req.price, volume: req.volume, comment: req.comment ?? '',
    };
  }
  async deletePendingOrder(ticket: number): Promise<TradeResult> {
    this.deletedPendings.push(ticket);
    return { retcode: DONE, ok: true, deal: 0, order: ticket, position: 0, price: 0, volume: 0, comment: 'removed' };
  }
  async modifyPendingOrder(ticket: number, price: number, sl: number, tp: number): Promise<TradeResult> {
    this.modifiedPendings.push({ ticket, price, sl, tp });
    return { retcode: DONE, ok: true, deal: 0, order: ticket, position: 0, price, volume: 0, comment: 'modified' };
  }
}

/** Broker WITHOUT the optional pending methods (the §21 honest-guard path). */
class MockBrokerNoPending implements IBroker {
  async placeMarketOrder(req: OrderRequest): Promise<TradeResult> {
    return { retcode: DONE, ok: true, deal: 1, order: 1, position: 1, price: 1.1, volume: req.volume, comment: '' };
  }
  async modifyPosition(): Promise<TradeResult> {
    return { retcode: DONE, ok: true, deal: 0, order: 0, position: 1, price: 0, volume: 0, comment: '' };
  }
  async closePosition(): Promise<TradeResult> {
    return { retcode: DONE, ok: true, deal: 0, order: 0, position: 0, price: 0, volume: 0, comment: '' };
  }
  getPosition(): Position | null {
    return null;
  }
  positions(): readonly Position[] {
    return [];
  }
  account(): AccountInfo {
    return ACCT;
  }
}

const CTX: RuntimeContext = { symbol: 'EURUSD', timeframe: 5 };

function makeRuntime(broker: IBroker): Runtime {
  const providers: Providers = { broker, feed: new MockFeed(), clock: new MockClock() };
  return createRuntime(providers, CTX);
}

// ─────────────────────────────────────────────────────────────────────────
// MqlTradeRequest / MqlTradeResult struct shape
// ─────────────────────────────────────────────────────────────────────────

describe('Mql trade structs zero-init every MQL5 field', () => {
  it('MqlTradeRequest has every documented field, zero/empty-defaulted', () => {
    const r = new MqlTradeRequest();
    expect(r).toEqual({
      action: 0, magic: 0, order: 0, symbol: '', volume: 0, price: 0,
      stoplimit: 0, sl: 0, tp: 0, deviation: 0, type: 0, type_filling: 0,
      type_time: 0, expiration: 0, comment: '', position: 0, position_by: 0,
    });
  });

  it('MqlTradeResult has every documented field, zero/empty-defaulted', () => {
    const r = new MqlTradeResult();
    expect(r).toEqual({
      retcode: 0, deal: 0, order: 0, volume: 0, price: 0, bid: 0, ask: 0,
      comment: '', request_id: 0, retcode_external: 0,
    });
  });

  it('MqlTradeCheckResult and MqlTradeTransaction construct zero-initialised', () => {
    const c = new MqlTradeCheckResult();
    expect(c.retcode).toBe(0);
    expect(c.margin_free).toBe(0);
    expect(c.comment).toBe('');
    const t = new MqlTradeTransaction();
    expect(t.deal).toBe(0);
    expect(t.symbol).toBe('');
    expect(t.position_by).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// OrderSend dispatch
// ─────────────────────────────────────────────────────────────────────────

describe('OrderSend dispatches on request.action and fills result in place', () => {
  it('TRADE_ACTION_DEAL places a market order, fills result.order/deal/price, returns true', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_DEAL;
    req.type = ORDER_TYPE_BUY;
    req.symbol = 'EURUSD';
    req.volume = 0.5;
    req.sl = 1.09;
    req.tp = 1.12;
    req.deviation = 10;
    req.magic = 4242;
    req.comment = 'deal';
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(res.retcode).toBe(DONE);
    expect(res.order).toBe(7000);
    expect(res.deal).toBe(7000);
    expect(res.volume).toBe(0.5);
    expect(res.comment).toBe('deal');
    // bid/ask not carried by the boundary → stay 0 (§21, never fabricated)
    expect(res.bid).toBe(0);
    expect(res.ask).toBe(0);
    expect(broker.marketOrders).toHaveLength(1);
    expect(broker.marketOrders[0]).toMatchObject({
      symbol: 'EURUSD', side: 'buy', volume: 0.5, sl: 1.09, tp: 1.12, deviation: 10, magic: 4242, comment: 'deal',
    });
  });

  it('TRADE_ACTION_DEAL with ORDER_TYPE_SELL maps to side=sell', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_DEAL;
    req.type = ORDER_TYPE_SELL;
    req.symbol = 'EURUSD';
    req.volume = 1;
    const res = new MqlTradeResult();
    expect(await orderSend(broker, req, res)).toBe(true);
    expect(broker.marketOrders[0]!.side).toBe('sell');
  });

  it('TRADE_ACTION_PENDING places a pending order with the mapped kind', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_PENDING;
    req.type = ORDER_TYPE_BUY_LIMIT;
    req.symbol = 'EURUSD';
    req.volume = 0.2;
    req.price = 1.0995;
    req.sl = 1.098;
    req.tp = 1.103;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(res.retcode).toBe(DONE);
    expect(res.order).toBe(7000);
    expect(res.price).toBe(1.0995);
    expect(broker.pendingPlaced).toHaveLength(1);
    expect(broker.pendingPlaced[0]).toMatchObject({
      symbol: 'EURUSD', kind: 'buyLimit', volume: 0.2, price: 1.0995, sl: 1.098, tp: 1.103,
    });
  });

  it('TRADE_ACTION_PENDING SELL_STOP maps to sellStop', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_PENDING;
    req.type = ORDER_TYPE_SELL_STOP;
    req.symbol = 'EURUSD';
    req.volume = 0.3;
    req.price = 1.0980;
    const res = new MqlTradeResult();
    await orderSend(broker, req, res);
    expect(broker.pendingPlaced[0]!.kind).toBe('sellStop');
  });

  it('TRADE_ACTION_SLTP modifies the open position SL/TP', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_SLTP;
    req.symbol = 'EURUSD';
    req.sl = 1.0900;
    req.tp = 1.1100;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(res.retcode).toBe(DONE);
    expect(broker.modifiedPositions).toEqual([{ symbol: 'EURUSD', sl: 1.09, tp: 1.11 }]);
  });

  it('TRADE_ACTION_MODIFY modifies a resting pending by order ticket', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_MODIFY;
    req.order = 5555;
    req.price = 1.1001;
    req.sl = 1.0985;
    req.tp = 1.1050;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(broker.modifiedPendings).toEqual([{ ticket: 5555, price: 1.1001, sl: 1.0985, tp: 1.105 }]);
  });

  it('TRADE_ACTION_REMOVE deletes a resting pending by order ticket', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_REMOVE;
    req.order = 8888;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(true);
    expect(broker.deletedPendings).toEqual([8888]);
    expect(res.comment).toBe('removed');
  });

  it('TRADE_ACTION_CLOSE_BY rejects honestly (no closeBy primitive) — false, no I/O', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_CLOSE_BY;
    req.position = 1;
    req.position_by = 2;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);

    expect(ok).toBe(false);
    expect(res.retcode).toBe(INVALID);
    expect(broker.marketOrders).toHaveLength(0);
  });

  it('a bad market type (a pending type on DEAL) is rejected, not faked', async () => {
    const broker = new MockBroker();
    const req = new MqlTradeRequest();
    req.action = TRADE_ACTION_DEAL;
    req.type = ORDER_TYPE_BUY_LIMIT; // not a market type
    req.symbol = 'EURUSD';
    req.volume = 0.1;
    const res = new MqlTradeResult();
    const ok = await orderSend(broker, req, res);
    expect(ok).toBe(false);
    expect(res.retcode).toBe(INVALID);
    expect(broker.marketOrders).toHaveLength(0);
  });

  it('§21 honest guard: PENDING/MODIFY/REMOVE on an egress without the optional methods fail loudly', async () => {
    const broker = new MockBrokerNoPending();
    for (const action of [TRADE_ACTION_PENDING, TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE]) {
      const req = new MqlTradeRequest();
      req.action = action;
      req.type = ORDER_TYPE_BUY_LIMIT;
      req.symbol = 'EURUSD';
      req.volume = 0.1;
      req.price = 1.1;
      req.order = 1;
      const res = new MqlTradeResult();
      const ok = await orderSend(broker, req, res);
      expect(ok).toBe(false);
      expect(res.retcode).toBe(INVALID);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CTrade completion: PositionOpen, OrderModify, setters, extra Result*
// ─────────────────────────────────────────────────────────────────────────

describe('CTrade.PositionOpen', () => {
  it('opens a BUY market position and round-trips the result', async () => {
    const broker = new MockBroker();
    const t = new CTrade(makeRuntime(broker));
    t.SetExpertMagicNumber(99);
    t.SetDeviationInPoints(15);
    const ok = await t.PositionOpen('EURUSD', ORDER_TYPE_BUY, 0.4, 0, 1.09, 1.12, 'po');
    expect(ok).toBe(true);
    expect(broker.marketOrders[0]).toMatchObject({
      symbol: 'EURUSD', side: 'buy', volume: 0.4, sl: 1.09, tp: 1.12, deviation: 15, magic: 99, comment: 'po',
    });
    expect(t.ResultRetcode()).toBe(DONE);
    expect(t.ResultVolume()).toBe(0.4);
    expect(t.ResultComment()).toBe('po');
  });

  it('opens a SELL and falls back to _Symbol when symbol is empty', async () => {
    const broker = new MockBroker();
    const t = new CTrade(makeRuntime(broker));
    expect(await t.PositionOpen('', ORDER_TYPE_SELL, 0.1)).toBe(true);
    expect(broker.marketOrders[0]).toMatchObject({ symbol: 'EURUSD', side: 'sell', volume: 0.1 });
  });

  it('rejects a non-market order type honestly (no I/O, retcode INVALID)', async () => {
    const broker = new MockBroker();
    const t = new CTrade(makeRuntime(broker));
    const ok = await t.PositionOpen('EURUSD', ORDER_TYPE_BUY_LIMIT, 0.1);
    expect(ok).toBe(false);
    expect(t.ResultRetcode()).toBe(INVALID);
    expect(broker.marketOrders).toHaveLength(0);
  });
});

describe('CTrade.OrderModify', () => {
  it('modifies a resting pending order by ticket and round-trips', async () => {
    const broker = new MockBroker();
    const t = new CTrade(makeRuntime(broker));
    const ok = await t.OrderModify(4321, 1.1002, 1.0980, 1.1060);
    expect(ok).toBe(true);
    expect(broker.modifiedPendings).toEqual([{ ticket: 4321, price: 1.1002, sl: 1.098, tp: 1.106 }]);
    expect(t.ResultRetcode()).toBe(DONE);
  });

  it('§21 honest guard: fails loudly on an egress without modifyPendingOrder', async () => {
    const t = new CTrade(makeRuntime(new MockBrokerNoPending()));
    const ok = await t.OrderModify(4321, 1.1, 1.0, 1.2);
    expect(ok).toBe(false);
    expect(t.ResultRetcode()).toBe(INVALID);
    expect(t.ResultRetcodeDescription()).toBe('TRADE_RETCODE_INVALID');
  });
});

describe('CTrade config setters + extra Result accessors', () => {
  it('SetTypeFillingBySymbol accepts the call (no effect on backtest, documented)', () => {
    const t = new CTrade(makeRuntime(new MockBroker()));
    expect(t.SetTypeFillingBySymbol('EURUSD')).toBe(true);
  });

  it('SetMarginMode / SetAsyncMode store config without throwing', () => {
    const t = new CTrade(makeRuntime(new MockBroker()));
    expect(() => t.SetMarginMode(0)).not.toThrow(); // §29: 0 is a valid mode
    expect(() => t.SetMarginMode()).not.toThrow();
    expect(() => t.SetAsyncMode(true)).not.toThrow();
    expect(() => t.SetAsyncMode(false)).not.toThrow();
  });

  it('RequestMagic reflects the configured magic number', () => {
    const t = new CTrade(makeRuntime(new MockBroker()));
    expect(t.RequestMagic()).toBe(0); // §29: 0 is the real default, not "unset"
    t.SetExpertMagicNumber(777);
    expect(t.RequestMagic()).toBe(777);
  });

  it('ResultBid/ResultAsk are not carried by the boundary → 0 (never fabricated)', async () => {
    const t = new CTrade(makeRuntime(new MockBroker()));
    await t.PositionOpen('EURUSD', ORDER_TYPE_BUY, 0.1);
    expect(t.ResultBid()).toBe(0);
    expect(t.ResultAsk()).toBe(0);
  });

  it('CheckResultRetcode reports the last trade retcode (honest interim)', async () => {
    const t = new CTrade(makeRuntime(new MockBroker()));
    await t.PositionOpen('EURUSD', ORDER_TYPE_BUY, 0.1);
    expect(t.CheckResultRetcode()).toBe(DONE);
  });

  it('ResultComment surfaces the broker comment from the last result', async () => {
    const broker = new MockBroker();
    const t = new CTrade(makeRuntime(broker));
    await t.PositionOpen('EURUSD', ORDER_TYPE_BUY, 0.1, 0, 0, 0, 'hello');
    expect(t.ResultComment()).toBe('hello');
  });
});

// sanity: MQL_CONST already carries the ORDER_TYPE_* + ORDER_TIME_* values we
// dispatch on, so a transpiled EA's `req.type = ORDER_TYPE_BUY_LIMIT` resolves.
describe('constants sanity', () => {
  it('ORDER_TYPE_* match the values OrderSend dispatches on', () => {
    expect(MQL_CONST.ORDER_TYPE_BUY).toBe(ORDER_TYPE_BUY);
    expect(MQL_CONST.ORDER_TYPE_SELL).toBe(ORDER_TYPE_SELL);
    expect(MQL_CONST.ORDER_TYPE_BUY_LIMIT).toBe(ORDER_TYPE_BUY_LIMIT);
    expect(MQL_CONST.ORDER_TYPE_SELL_STOP).toBe(ORDER_TYPE_SELL_STOP);
  });
});
