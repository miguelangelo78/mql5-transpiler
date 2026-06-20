/**
 * TickerAll provider tests — deterministic, against a MOCK Tickerall client.
 *
 * Validates the SDK<->boundary mapping, the sync-over-async caches (feed +
 * broker), and the full factory wiring (seed + stream → cache updates + the
 * onTick hook) without needing a live broker account. The live path is proven
 * separately against the real API; this is the durable regression net.
 */

import { describe, expect, it } from 'vitest';
import type { Tickerall } from '@tickerall/sdk';

import {
  tfToSdk,
  candleToBar,
  sdkSpecToSpec,
  sdkPositionToPosition,
  sdkAccountToAccount,
  pendingKindToSdk,
  historyTradeToDeal,
} from '../src/runtime/providers/tickerall/mapping';
import { TickerallFeed } from '../src/runtime/providers/tickerall/feed';
import { TickerallBroker } from '../src/runtime/providers/tickerall/broker';
import { createTickerallProviders } from '../src/runtime/providers/tickerall';

// ── A structural mock of the bits of the SDK the provider touches ──────────
function makeMock() {
  let tickCb: ((e: unknown) => void) | undefined;
  const calls: Record<string, unknown[]> = {};
  const rec = (k: string, ...a: unknown[]) => { (calls[k] ??= []).push(a); };
  const stream = {
    subscribeTicks: async () => {},
    subscribePositions: async () => {},
    subscribeAccount: async () => {},
    on: (ev: string, cb: (e: unknown) => void) => { if (ev === 'tick') tickCb = cb; },
    close: async () => {},
    emitTick: (e: unknown) => tickCb?.(e),
  };
  const client = {
    sessions: {
      start: async (p: unknown) => { rec('start', p); return { accountId: 'acc_test', isDemo: true, status: 'connected' }; },
      end: async (id: unknown) => { rec('end', id); },
    },
    accounts: {
      symbolSpecs: async () => [
        { name: 'EURUSD', volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01, specSource: 'broker', digits: 5, point: 1e-5, contractSize: 100000, tickValue: 1 },
      ],
      get: async () => ({
        status: 'online', id: 'acc_test', broker: 'mt5', server: 'X', accountNumber: '12345678', isDemo: true,
        account: { name: 'Demo', accountType: 'demo', leverage: 500, balance: 10000, currency: 'USD', equity: 9990, margin: 50, freeMargin: 9940 },
        positions: [
          { ticket: 555, symbol: 'EURUSD', side: 'BUY', volume: 0.1, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, profit: 3.2, magic: 0, comment: 'x', swap: 0, commission: 0 },
        ],
      }),
    },
    candles: {
      get: async () => [
        { timestamp: 1000, open: 1.10, high: 1.11, low: 1.09, close: 1.105, bid: 1.105, tickVolume: 5, spread: 1e-4 },
        { timestamp: 1300, open: 1.105, high: 1.12, low: 1.10, close: 1.118, bid: 1.118, tickVolume: 7, spread: 1e-4 },
      ],
    },
    orders: {
      place: async (_id: string, params: { symbol: string; side: string; type: string; volume: number; comment?: string }) => {
        rec('place', params);
        return { ticket: 777, symbol: params.symbol, side: params.side, type: params.type, volume: params.volume, price: undefined, stopLoss: null, takeProfit: null, comment: params.comment ?? null, status: 'open', timestamp: '' };
      },
      listPending: async () => [],
      cancelPending: async (_id: string, ticket: number) => ({ ticket, symbol: 'EURUSD', side: 'BUY', cancelled: true, timestamp: '' }),
      modifyPending: async (_id: string, ticket: number) => ({ ticket, symbol: 'EURUSD', side: 'BUY', price: 1.1, stopLoss: 1.09, takeProfit: 1.12, timestamp: '' }),
    },
    positions: {
      close: async (_id: string, ticket: number) => { rec('close', ticket); return { ticket, symbol: 'EURUSD', side: 'BUY', volume: 0.1, closed: true, timestamp: '' }; },
      modify: async (_id: string, ticket: number) => { rec('modify', ticket); return { ticket, symbol: 'EURUSD', side: 'BUY', volume: 0.1, stopLoss: 1.08, takeProfit: 1.13, timestamp: '' }; },
    },
    history: { get: async () => [] },
    stream: { connect: async () => stream },
  };
  return { client, stream, calls };
}

const asClient = (m: ReturnType<typeof makeMock>['client']) => m as unknown as Tickerall;

describe('TickerAll mapping (pure)', () => {
  it('tfToSdk maps MT5 timeframe ids to SDK strings', () => {
    expect(tfToSdk(1)).toBe('M1');
    expect(tfToSdk(15)).toBe('M15');
    expect(tfToSdk(16385)).toBe('H1');
    expect(tfToSdk(999)).toBe('M5'); // unknown → default
  });
  it('candleToBar carries OHLC + tickVolume/spread, realVolume 0', () => {
    const b = candleToBar({ timestamp: 9, open: 1, high: 2, low: 0.5, close: 1.5, bid: 1.5, tickVolume: 3, spread: 0.001 });
    expect(b).toMatchObject({ time: 9, open: 1, high: 2, low: 0.5, close: 1.5, tickVolume: 3, spread: 0.001, realVolume: 0 });
  });
  it('sdkSpecToSpec derives point/tickValue when absent', () => {
    const s = sdkSpecToSpec({ name: 'X', volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, specSource: 'derived' });
    expect(s.digits).toBe(5);
    expect(s.point).toBeCloseTo(1e-5);
    expect(s.contractSize).toBe(100000);
    expect(s.tickValue).toBeCloseTo(1);
  });
  it('sdkPositionToPosition lowercases side and maps entryPrice→openPrice', () => {
    const p = sdkPositionToPosition({ ticket: 1, symbol: 'E', side: 'SELL', volume: 0.2, entryPrice: 1.2, stopLoss: 0, takeProfit: 0, profit: -1, magic: 7, comment: 'c', swap: 0, commission: 0 });
    expect(p.side).toBe('sell');
    expect(p.openPrice).toBe(1.2);
    expect(p.magic).toBe(7);
  });
  it('sdkAccountToAccount fills equity/freeMargin fallbacks', () => {
    const a = sdkAccountToAccount({ name: 'n', accountType: 'demo', leverage: 100, balance: 5000 }, '7654321');
    expect(a.balance).toBe(5000);
    expect(a.equity).toBe(5000); // fallback to balance
    expect(a.login).toBe(7654321);
  });
  it('pendingKindToSdk rejects stop-limit (TickerAll has no stop-limit)', () => {
    expect(pendingKindToSdk('buyLimit')).toEqual({ type: 'limit', side: 'BUY' });
    expect(pendingKindToSdk('sellStop')).toEqual({ type: 'stop', side: 'SELL' });
    expect(pendingKindToSdk('buyStopLimit')).toBeNull();
  });
  it('historyTradeToDeal maps a round-trip to a realised CLOSE deal', () => {
    const d = historyTradeToDeal({ ticket: '10', symbol: 'E', side: 'BUY', volume: 0.1, openPrice: 1, closePrice: 1.1, openTime: '2024-01-01T00:00:00Z', closeTime: '2024-01-01T01:00:00Z', profit: 9.5, swap: 0, commission: 0, stopLoss: 0, takeProfit: 0, closeTicket: '11', complete: true });
    expect(d.entry).toBe('close');
    expect(d.profit).toBe(9.5);
    expect(d.ticket).toBe(11);
  });
});

describe('TickerallFeed (sync cache over async data)', () => {
  it('history returns a stable snapshot; tick updates the forming bar', () => {
    const feed = new TickerallFeed('EURUSD', 5);
    feed.seedBars('EURUSD', [
      { time: 0, open: 1, high: 1, low: 1, close: 1, tickVolume: 1, spread: 0, realVolume: 0 },
    ]);
    const snap = feed.history('EURUSD', 5);
    expect(snap.length).toBe(1);
    // a tick in the same 300s bucket updates the forming bar (replace, not mutate)
    feed.onTick('EURUSD', 1.5, 1.5002, 100);
    expect(feed.history('EURUSD', 5).at(-1)!.high).toBe(1.5);
    expect(snap.at(-1)!.high).toBe(1); // the earlier snapshot is unchanged
    expect(feed.tick('EURUSD').bid).toBe(1.5);
  });
  it('history throws for an unbound timeframe (§21 single-context)', () => {
    const feed = new TickerallFeed('EURUSD', 5);
    expect(() => feed.history('EURUSD', 15)).toThrow(/bound to 5/);
  });
});

describe('TickerallBroker (orders over a mock client + sync reads)', () => {
  it('placeMarketOrder maps to orders.place and returns a DONE TradeResult', async () => {
    const m = makeMock();
    const b = new TickerallBroker(asClient(m.client), 'acc_test');
    const r = await b.placeMarketOrder({ symbol: 'EURUSD', side: 'buy', volume: 0.1, sl: 1.09, tp: 1.12 });
    expect(r.ok).toBe(true);
    expect(r.order).toBe(777);
    expect((m.calls.place![0] as [{ side: string }])[0].side).toBe('BUY');
  });
  it('placePendingOrder rejects stop-limit honestly (no fake success)', async () => {
    const m = makeMock();
    const b = new TickerallBroker(asClient(m.client), 'acc_test');
    const r = await b.placePendingOrder({ symbol: 'EURUSD', kind: 'buyStopLimit', volume: 0.1, price: 1.1 });
    expect(r.ok).toBe(false);
    expect(r.comment).toMatch(/stop-limit/i);
  });
  it('closePosition resolves the ticket from the cached position', async () => {
    const m = makeMock();
    const b = new TickerallBroker(asClient(m.client), 'acc_test');
    b.setPositions([sdkPositionToPosition({ ticket: 555, symbol: 'EURUSD', side: 'BUY', volume: 0.1, entryPrice: 1.1, stopLoss: 0, takeProfit: 0, profit: 0, magic: 0, comment: '', swap: 0, commission: 0 })]);
    const r = await b.closePosition('EURUSD');
    expect(r.ok).toBe(true);
    expect(m.calls.close![0]).toEqual([555]);
    // no position on an unknown symbol → honest reject, no API call
    const r2 = await b.closePosition('GBPUSD');
    expect(r2.ok).toBe(false);
  });
});

describe('createTickerallProviders (full factory wiring, mock client)', () => {
  it('seeds feed/account/positions and the tick stream feeds the cache + onTick', async () => {
    const m = makeMock();
    const live = await createTickerallProviders({
      apiKey: 'x', broker: 'mt5', server: 'X', account: 1, password: 'y',
      symbol: 'EURUSD', timeframe: 5, client: asClient(m.client),
    });
    // seeded
    expect(live.providers.feed.history('EURUSD', 5).length).toBe(2);
    expect(live.providers.broker.account().balance).toBe(10000);
    expect(live.providers.broker.positions().length).toBe(1);
    // a streamed tick reaches the feed + fires onTick
    let fired = '';
    live.onTick((s) => { fired = s; });
    m.stream.emitTick({ type: 'tick', accountId: 'acc_test', symbol: 'EURUSD', bid: 1.2, ask: 1.2002, timestamp: '2024-01-01T00:00:00Z' });
    expect(fired).toBe('EURUSD');
    expect(live.providers.feed.tick('EURUSD').bid).toBe(1.2);
    await live.disconnect();
  });
});
