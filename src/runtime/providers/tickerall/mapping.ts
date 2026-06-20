/**
 * Mapping between the TickerAll SDK shapes (@tickerall/sdk) and this engine's
 * language-neutral provider-boundary types (../types.ts). One place so the
 * feed/broker stay thin and every SDK<->boundary conversion is auditable.
 *
 * §21 honesty notes (TickerAll exposes slightly less than a raw terminal):
 *  - SymbolSpec fields can be `specSource: 'derived'` (best-effort defaults),
 *    not broker-authoritative; we surface what TickerAll gives + documented
 *    fallbacks, never a fabricated authoritative value.
 *  - Stop-limit pending orders are not representable on TickerAll (only
 *    limit/stop) — `pendingKindToSdk` returns null for them so the broker can
 *    reject honestly instead of mis-sending.
 *  - History is round-trips, not raw deal legs — each round-trip maps to one
 *    realised CLOSE deal record.
 */

import type {
  Candle as SdkCandle,
  Position as SdkPosition,
  AccountInfo as SdkAccountInfo,
  SymbolSpec as SdkSymbolSpec,
  PendingOrder as SdkPendingOrder,
  HistoryTrade,
  Timeframe,
} from '@tickerall/sdk';

import type {
  Bar,
  Position,
  AccountInfo,
  SymbolSpec,
  PendingOrder,
  PendingKind,
  OrderSide,
  DealRecord,
} from '../types';

/** MT5 ENUM_TIMEFRAMES integer → SDK timeframe string. Defaults to M5. */
export function tfToSdk(tf: number): Timeframe {
  switch (tf) {
    case 1: return 'M1';
    case 5: return 'M5';
    case 15: return 'M15';
    case 30: return 'M30';
    case 16385: return 'H1';
    case 16388: return 'H4';
    case 16408: return 'D1';
    case 32769: return 'W1';
    case 49153: return 'MN1';
    default: return 'M5';
  }
}

/** Seconds per bar for a given MT5 timeframe id (for forming-bar bucketing). */
export function tfSeconds(tf: number): number {
  switch (tf) {
    case 1: return 60;
    case 5: return 300;
    case 15: return 900;
    case 30: return 1800;
    case 16385: return 3600;
    case 16388: return 14400;
    case 16408: return 86400;
    case 32769: return 604800;
    case 49153: return 2592000; // 30d approximation
    default: return 300;
  }
}

/** ISO-8601 (or epoch-ish) → epoch seconds. 0 when absent/unparseable. */
export function toEpochSeconds(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export function sdkSideToSide(side: 'BUY' | 'SELL'): OrderSide {
  return side === 'BUY' ? 'buy' : 'sell';
}

export function sideToSdk(side: OrderSide): 'BUY' | 'SELL' {
  return side === 'buy' ? 'BUY' : 'SELL';
}

export function candleToBar(c: SdkCandle): Bar {
  return {
    time: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    tickVolume: c.tickVolume ?? 0,
    spread: c.spread ?? 0,
    realVolume: 0,
  };
}

/**
 * SDK SymbolSpec → boundary SymbolSpec. TickerAll always carries the volume
 * fields; digits/point/contractSize/tickValue may be absent on derived specs,
 * so we fall back to FX-sensible defaults (digits 5) and DERIVE point/tickSize/
 * tickValue from what's present. Documented best-effort, never authoritative.
 */
export function sdkSpecToSpec(s: SdkSymbolSpec): SymbolSpec {
  const digits = s.digits ?? 5;
  const point = s.point ?? Math.pow(10, -digits);
  const contractSize = s.contractSize ?? 100000;
  const tickSize = s.tickSize ?? point;
  const tickValue = s.tickValue ?? contractSize * point;
  return {
    name: s.name,
    digits,
    point,
    volumeMin: s.volumeMin,
    volumeMax: s.volumeMax,
    volumeStep: s.volumeStep,
    contractSize,
    tickSize,
    tickValue,
  };
}

export function sdkPositionToPosition(p: SdkPosition): Position {
  return {
    ticket: p.ticket,
    symbol: p.symbol,
    side: sdkSideToSide(p.side),
    volume: p.volume,
    openPrice: p.entryPrice ?? 0,
    openTime: toEpochSeconds(p.openTime),
    sl: p.stopLoss,
    tp: p.takeProfit,
    profit: p.profit ?? 0,
    swap: p.swap,
    magic: p.magic,
    comment: p.comment,
  };
}

export function sdkAccountToAccount(
  a: SdkAccountInfo,
  accountNumber: string,
): AccountInfo {
  const equity = a.equity ?? a.balance;
  const margin = a.margin ?? 0;
  return {
    login: Number(accountNumber.replace(/\D/g, '')) || 0,
    currency: a.currency ?? 'USD',
    leverage: a.leverage,
    balance: a.balance,
    equity,
    margin,
    freeMargin: a.freeMargin ?? equity - margin,
  };
}

const SDK_TYPE_TO_KIND: Record<string, PendingKind | undefined> = {
  BUY_LIMIT: 'buyLimit',
  SELL_LIMIT: 'sellLimit',
  BUY_STOP: 'buyStop',
  SELL_STOP: 'sellStop',
  BUY_STOP_LIMIT: 'buyStopLimit',
  SELL_STOP_LIMIT: 'sellStopLimit',
};

export function sdkPendingToPending(p: SdkPendingOrder): PendingOrder {
  return {
    ticket: Number(p.ticket),
    symbol: p.symbol,
    kind: SDK_TYPE_TO_KIND[p.type] ?? 'buyLimit',
    volume: p.volume,
    price: p.price,
    ...(p.limitPrice !== null ? { stopLimitPrice: p.limitPrice } : {}),
    sl: p.stopLoss,
    tp: p.takeProfit,
    placedTime: toEpochSeconds(p.setTime),
    magic: 0,
    comment: '',
  };
}

/**
 * PendingKind → the TickerAll order shape. Returns null for stop-limit kinds:
 * TickerAll's order API has only `limit`/`stop` (no stop-limit), so the broker
 * rejects those honestly rather than silently dropping the second price.
 */
export function pendingKindToSdk(
  kind: PendingKind,
): { type: 'limit' | 'stop'; side: 'BUY' | 'SELL' } | null {
  switch (kind) {
    case 'buyLimit': return { type: 'limit', side: 'BUY' };
    case 'sellLimit': return { type: 'limit', side: 'SELL' };
    case 'buyStop': return { type: 'stop', side: 'BUY' };
    case 'sellStop': return { type: 'stop', side: 'SELL' };
    default: return null; // buyStopLimit / sellStopLimit — unsupported on TickerAll
  }
}

/**
 * A closed round-trip → one realised CLOSE deal record. TickerAll exposes
 * round-trips (entry+exit paired), not raw deal legs, so we surface the close
 * leg carrying the realised P/L (the open leg's P/L is 0 in MT5 anyway).
 */
export function historyTradeToDeal(t: HistoryTrade): DealRecord {
  return {
    ticket: Number(t.closeTicket ?? t.ticket),
    order: Number(t.ticket),
    time: toEpochSeconds(t.closeTime),
    symbol: t.symbol,
    side: sdkSideToSide(t.side),
    entry: 'close',
    volume: t.volume,
    price: t.closePrice,
    profit: t.profit ?? 0,
    commission: t.commission,
    swap: t.swap,
    comment: '',
  };
}
