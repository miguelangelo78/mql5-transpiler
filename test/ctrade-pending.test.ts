/**
 * CTrade pending-order + timer tests.
 *
 *  (a) BuyLimit/SellLimit/BuyStop/SellStop against a mock IBroker that
 *      IMPLEMENTS placePendingOrder → records the pending, returns true, and
 *      ResultOrder()/ResultRetcode() reflect the returned ticket.
 *  (b) The §21 HONEST GUARD: against a mock IBroker WITHOUT placePendingOrder
 *      (the optional method is undefined) → returns false, NEVER faking
 *      success, with a clear failure retcode.
 *  (c) OrderDelete with / without deletePendingOrder.
 *  (d) EventSetTimer(60)/__timerSeconds()===60; EventKillTimer()→0;
 *      EventSetMillisecondTimer(2500)→2.5; and 0 (no timer) is distinct.
 *
 * Run: npx vitest run test/ctrade-pending.test.ts
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime/index';
import { CTrade } from '../src/runtime/ctrade';
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

function emptyTradeRes(): TradeResult {
  return { retcode: 0, ok: false, deal: 0, order: 0, position: 0, price: 0, volume: 0, comment: '' };
}

/** Base broker with the REQUIRED methods only (pending methods absent). */
class BrokerNoPending implements IBroker {
  async placeMarketOrder(_req: OrderRequest): Promise<TradeResult> {
    return emptyTradeRes();
  }
  async modifyPosition(): Promise<TradeResult> {
    return emptyTradeRes();
  }
  async closePosition(): Promise<TradeResult> {
    return emptyTradeRes();
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

/** Broker that DOES support pending orders — records every placement. */
class BrokerWithPending extends BrokerNoPending {
  public placed: PendingOrderRequest[] = [];
  public deleted: number[] = [];
  private resting: PendingOrder[] = [];
  private nextTicket = 5000;

  async placePendingOrder(req: PendingOrderRequest): Promise<TradeResult> {
    this.placed.push(req);
    const ticket = this.nextTicket++;
    this.resting.push({
      ticket,
      symbol: req.symbol,
      kind: req.kind,
      volume: req.volume,
      price: req.price,
      stopLimitPrice: req.stopLimitPrice,
      sl: req.sl ?? 0,
      tp: req.tp ?? 0,
      placedTime: 1_000_060,
      magic: req.magic ?? 0,
      comment: req.comment ?? '',
    });
    return {
      retcode: MQL_CONST.TRADE_RETCODE_DONE,
      ok: true,
      deal: 0,
      order: ticket,
      position: 0,
      price: req.price,
      volume: req.volume,
      comment: '',
    };
  }
  async deletePendingOrder(ticket: number): Promise<TradeResult> {
    this.deleted.push(ticket);
    const had = this.resting.some((p) => p.ticket === ticket);
    this.resting = this.resting.filter((p) => p.ticket !== ticket);
    return {
      retcode: had ? MQL_CONST.TRADE_RETCODE_DONE : 10013,
      ok: had,
      deal: 0,
      order: ticket,
      position: 0,
      price: 0,
      volume: 0,
      comment: '',
    };
  }
  pendingOrders(): readonly PendingOrder[] {
    return this.resting;
  }
  getPendingOrder(ticket: number): PendingOrder | null {
    return this.resting.find((p) => p.ticket === ticket) ?? null;
  }
}

const CTX: RuntimeContext = { symbol: 'EURUSD', timeframe: 5 };

function makeRuntime(broker: IBroker): Runtime {
  const providers: Providers = { broker, feed: new MockFeed(), clock: new MockClock() };
  return createRuntime(providers, CTX);
}

// ─────────────────────────────────────────────────────────────────────────
// Pending orders — supported egress
// ─────────────────────────────────────────────────────────────────────────

describe('CTrade pending orders — supported egress', () => {
  it('BuyLimit records a buyLimit pending and returns true; ResultOrder() reflects the ticket', async () => {
    const broker = new BrokerWithPending();
    const t = new CTrade(makeRuntime(broker));
    const ok = await t.BuyLimit!(0.1, 1.0995, 'EURUSD', 1.0980, 1.1035, 'buylimit');
    expect(ok).toBe(true);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({
      symbol: 'EURUSD',
      kind: 'buyLimit',
      volume: 0.1,
      price: 1.0995,
      sl: 1.0980,
      tp: 1.1035,
      comment: 'buylimit',
    });
    expect(t.ResultOrder()).toBe(5000);
    expect(t.ResultRetcode()).toBe(MQL_CONST.TRADE_RETCODE_DONE);
    // the order is now resting
    expect(broker.pendingOrders()).toHaveLength(1);
    expect(broker.getPendingOrder(5000)?.kind).toBe('buyLimit');
  });

  it('SellLimit / BuyStop / SellStop map to the right PendingKind', async () => {
    const broker = new BrokerWithPending();
    const t = new CTrade(makeRuntime(broker));
    expect(await t.SellLimit!(0.2, 1.1010)).toBe(true);
    expect(await t.BuyStop!(0.3, 1.1020)).toBe(true);
    expect(await t.SellStop!(0.4, 1.0990)).toBe(true);
    expect(broker.placed.map((p) => p.kind)).toEqual(['sellLimit', 'buyStop', 'sellStop']);
    // default symbol falls back to _Symbol when omitted
    expect(broker.placed.every((p) => p.symbol === 'EURUSD')).toBe(true);
  });

  it('uses the configured magic number on the pending request', async () => {
    const broker = new BrokerWithPending();
    const t = new CTrade(makeRuntime(broker));
    t.SetExpertMagicNumber(424242);
    await t.BuyLimit!(0.1, 1.0995);
    expect(broker.placed[0]!.magic).toBe(424242);
  });

  it('OrderDelete deletes a resting pending and returns true', async () => {
    const broker = new BrokerWithPending();
    const t = new CTrade(makeRuntime(broker));
    await t.BuyLimit!(0.1, 1.0995);
    const ticket = t.ResultOrder();
    const ok = await t.OrderDelete!(ticket);
    expect(ok).toBe(true);
    expect(broker.deleted).toEqual([ticket]);
    expect(broker.pendingOrders()).toHaveLength(0);
  });

  it('OrderDelete of an unknown ticket returns false (no fake success)', async () => {
    const broker = new BrokerWithPending();
    const t = new CTrade(makeRuntime(broker));
    const ok = await t.OrderDelete!(99999);
    expect(ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Pending orders — UNSUPPORTED egress (the §21 honest guard)
// ─────────────────────────────────────────────────────────────────────────

describe('CTrade pending orders — honest guard on an egress that cannot place them', () => {
  it('BuyLimit returns false (never fakes success) and sets a clear failure retcode', async () => {
    const broker = new BrokerNoPending(); // placePendingOrder is undefined
    const t = new CTrade(makeRuntime(broker));
    const ok = await t.BuyLimit!(0.1, 1.0995, 'EURUSD', 1.098, 1.103);
    expect(ok).toBe(false);
    expect(t.ResultRetcode()).toBe(10013); // TRADE_RETCODE_INVALID
    expect(t.ResultRetcodeDescription()).toBe('TRADE_RETCODE_INVALID');
    expect(t.ResultOrder()).toBe(0);
  });

  it('SellLimit / BuyStop / SellStop all fail honestly too', async () => {
    const t = new CTrade(makeRuntime(new BrokerNoPending()));
    expect(await t.SellLimit!(0.1, 1.101)).toBe(false);
    expect(await t.BuyStop!(0.1, 1.102)).toBe(false);
    expect(await t.SellStop!(0.1, 1.099)).toBe(false);
  });

  it('OrderDelete returns false honestly when the egress cannot delete pendings', async () => {
    const t = new CTrade(makeRuntime(new BrokerNoPending()));
    const ok = await t.OrderDelete!(5000);
    expect(ok).toBe(false);
    expect(t.ResultRetcode()).toBe(10013);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Timer host hooks
// ─────────────────────────────────────────────────────────────────────────

describe('EventSetTimer / EventKillTimer / __timerSeconds', () => {
  it('EventSetTimer(60) then __timerSeconds() === 60', () => {
    const rt = makeRuntime(new BrokerNoPending());
    expect(rt.__timerSeconds!()).toBe(0); // no timer initially
    expect(rt.EventSetTimer!(60)).toBe(true);
    expect(rt.__timerSeconds!()).toBe(60);
  });

  it('EventKillTimer() resets the interval to 0', () => {
    const rt = makeRuntime(new BrokerNoPending());
    rt.EventSetTimer!(60);
    rt.EventKillTimer!();
    expect(rt.__timerSeconds!()).toBe(0);
  });

  it('EventSetMillisecondTimer(2500) stores 2.5 seconds', () => {
    const rt = makeRuntime(new BrokerNoPending());
    expect(rt.EventSetMillisecondTimer!(2500)).toBe(true);
    expect(rt.__timerSeconds!()).toBe(2.5);
  });

  it('rejects a non-positive interval (returns false, leaves timer unchanged)', () => {
    const rt = makeRuntime(new BrokerNoPending());
    rt.EventSetTimer!(30);
    expect(rt.EventSetTimer!(0)).toBe(false); // 0 is not a valid interval to START
    expect(rt.__timerSeconds!()).toBe(30); // unchanged
    expect(rt.EventSetTimer!(-5)).toBe(false);
    expect(rt.__timerSeconds!()).toBe(30);
  });

  it('§29: a killed timer (0) is distinct from a running one — 0 is a real state', () => {
    const rt = makeRuntime(new BrokerNoPending());
    rt.EventSetTimer!(15);
    expect(rt.__timerSeconds!()).toBe(15);
    rt.EventKillTimer!();
    // 0 here means "no timer", read via the explicit numeric, never truthiness.
    expect(rt.__timerSeconds!()).toBe(0);
  });
});
