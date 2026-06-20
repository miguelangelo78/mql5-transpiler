/**
 * Intrinsic classification table.
 *
 * Maps each MQL5 builtin name to an IntrinsicInfo {provider, name, isAsync}
 * (see ../ir/nodes.ts). Lowering consults this to classify free-function calls
 * and CTrade method calls, and to decide which call sites must be `await`ed.
 *
 * The async discipline (mirrors ../runtime/providers/types.ts):
 *   - Order-PLACING broker ops (CTrade.Buy/Sell/PositionClose/PositionModify)
 *     are async — real I/O on the live provider.
 *   - EVERYTHING ELSE is synchronous: indicators are computed locally from feed
 *     candles; position/account/symbol reads hit locally-cached state; array,
 *     math, string, time, and host helpers never do I/O.
 *
 * This table is the single source of truth for "is this name a builtin?", and
 * is expected to GROW. Adding a builtin = add a row here + implement it on the
 * Runtime.
 */

import type { IntrinsicInfo } from '../ir/nodes';
import { MQL_CONST } from '../runtime/constants';

// ─────────────────────────────────────────────────────────────────────────
// Free-function intrinsics (called as `name(...)`)
// ─────────────────────────────────────────────────────────────────────────

/**
 * For these, `name` equals the runtime method name (the emitter produces
 * `rt.<name>(args)`), so the table maps to {provider, isAsync} and `name` is
 * filled in from the key.
 */
const FREE_INTRINSICS: Record<string, { provider: IntrinsicInfo['provider']; isAsync: boolean }> = {
  // ── indicators (feed; computed locally, synchronous) ──
  iMA: { provider: 'feed', isAsync: false },
  iRSI: { provider: 'feed', isAsync: false },
  iATR: { provider: 'feed', isAsync: false },
  iMACD: { provider: 'feed', isAsync: false },
  iBands: { provider: 'feed', isAsync: false },
  iStochastic: { provider: 'feed', isAsync: false },
  iADX: { provider: 'feed', isAsync: false },
  iCCI: { provider: 'feed', isAsync: false },
  iMomentum: { provider: 'feed', isAsync: false },
  iCustom: { provider: 'feed', isAsync: false },
  CopyBuffer: { provider: 'feed', isAsync: false },
  IndicatorRelease: { provider: 'feed', isAsync: false },

  // ── timeseries (feed; sync) ──
  Bars: { provider: 'feed', isAsync: false },
  iBars: { provider: 'feed', isAsync: false },
  CopyClose: { provider: 'feed', isAsync: false },
  CopyOpen: { provider: 'feed', isAsync: false },
  CopyHigh: { provider: 'feed', isAsync: false },
  CopyLow: { provider: 'feed', isAsync: false },
  CopyTime: { provider: 'feed', isAsync: false },
  CopyTickVolume: { provider: 'feed', isAsync: false },
  CopyRealVolume: { provider: 'feed', isAsync: false },
  CopySpread: { provider: 'feed', isAsync: false },
  CopyRates: { provider: 'feed', isAsync: false },
  iClose: { provider: 'feed', isAsync: false },
  iOpen: { provider: 'feed', isAsync: false },
  iHigh: { provider: 'feed', isAsync: false },
  iLow: { provider: 'feed', isAsync: false },
  iTime: { provider: 'feed', isAsync: false },
  iVolume: { provider: 'feed', isAsync: false },
  iHighest: { provider: 'feed', isAsync: false },
  iLowest: { provider: 'feed', isAsync: false },

  // ── arrays (host; sync) ──
  ArraySetAsSeries: { provider: 'host', isAsync: false },
  ArrayGetAsSeries: { provider: 'host', isAsync: false },
  ArrayResize: { provider: 'host', isAsync: false },
  ArraySize: { provider: 'host', isAsync: false },
  ArrayFill: { provider: 'host', isAsync: false },
  ArrayInitialize: { provider: 'host', isAsync: false },
  ArrayCopy: { provider: 'host', isAsync: false },
  ArrayMaximum: { provider: 'host', isAsync: false },
  ArrayMinimum: { provider: 'host', isAsync: false },
  ArraySort: { provider: 'host', isAsync: false },

  // ── positions (broker; sync cached reads) ──
  PositionSelect: { provider: 'broker', isAsync: false },
  PositionSelectByTicket: { provider: 'broker', isAsync: false },
  PositionsTotal: { provider: 'broker', isAsync: false },
  PositionGetSymbol: { provider: 'broker', isAsync: false },
  PositionGetInteger: { provider: 'broker', isAsync: false },
  PositionGetDouble: { provider: 'broker', isAsync: false },
  PositionGetString: { provider: 'broker', isAsync: false },
  PositionGetTicket: { provider: 'broker', isAsync: false },

  // ── orders / deals (broker; sync cached reads) ──
  OrdersTotal: { provider: 'broker', isAsync: false },
  OrderSelect: { provider: 'broker', isAsync: false },
  OrderGetTicket: { provider: 'broker', isAsync: false },
  OrderGetInteger: { provider: 'broker', isAsync: false },
  OrderGetDouble: { provider: 'broker', isAsync: false },
  OrderGetString: { provider: 'broker', isAsync: false },
  HistorySelect: { provider: 'broker', isAsync: false },
  HistoryDealsTotal: { provider: 'broker', isAsync: false },
  HistoryDealGetTicket: { provider: 'broker', isAsync: false },
  HistoryDealGetInteger: { provider: 'broker', isAsync: false },
  HistoryDealGetDouble: { provider: 'broker', isAsync: false },
  HistoryDealGetString: { provider: 'broker', isAsync: false },

  // ── account (broker; sync) ──
  AccountInfoDouble: { provider: 'broker', isAsync: false },
  AccountInfoInteger: { provider: 'broker', isAsync: false },
  AccountInfoString: { provider: 'broker', isAsync: false },

  // ── symbol (feed; sync) ──
  SymbolInfoDouble: { provider: 'feed', isAsync: false },
  SymbolInfoInteger: { provider: 'feed', isAsync: false },
  SymbolInfoString: { provider: 'feed', isAsync: false },
  SymbolInfoTick: { provider: 'feed', isAsync: false },
  SymbolSelect: { provider: 'feed', isAsync: false },

  // ── time (clock; sync) ──
  TimeCurrent: { provider: 'clock', isAsync: false },
  TimeLocal: { provider: 'clock', isAsync: false },
  TimeTradeServer: { provider: 'clock', isAsync: false },
  TimeGMT: { provider: 'clock', isAsync: false },
  TimeToStruct: { provider: 'clock', isAsync: false },

  // ── timer (host; sync — sets the OnTimer cadence the engine driver reads) ──
  EventSetTimer: { provider: 'host', isAsync: false },
  EventSetMillisecondTimer: { provider: 'host', isAsync: false },
  EventKillTimer: { provider: 'host', isAsync: false },

  // ── normalization / math / string / host helpers (host; sync) ──
  NormalizeDouble: { provider: 'host', isAsync: false },
  MathAbs: { provider: 'host', isAsync: false },
  MathMax: { provider: 'host', isAsync: false },
  MathMin: { provider: 'host', isAsync: false },
  MathFloor: { provider: 'host', isAsync: false },
  MathCeil: { provider: 'host', isAsync: false },
  MathRound: { provider: 'host', isAsync: false },
  MathSqrt: { provider: 'host', isAsync: false },
  MathPow: { provider: 'host', isAsync: false },
  MathLog: { provider: 'host', isAsync: false },
  MathExp: { provider: 'host', isAsync: false },
  MathSin: { provider: 'host', isAsync: false },
  MathCos: { provider: 'host', isAsync: false },
  MathTan: { provider: 'host', isAsync: false },
  MathMod: { provider: 'host', isAsync: false },
  MathRand: { provider: 'host', isAsync: false },
  StringFormat: { provider: 'host', isAsync: false },
  StringLen: { provider: 'host', isAsync: false },
  StringSubstr: { provider: 'host', isAsync: false },
  StringFind: { provider: 'host', isAsync: false },
  StringReplace: { provider: 'host', isAsync: false },
  StringToDouble: { provider: 'host', isAsync: false },
  StringToInteger: { provider: 'host', isAsync: false },
  DoubleToString: { provider: 'host', isAsync: false },
  IntegerToString: { provider: 'host', isAsync: false },
  TimeToString: { provider: 'host', isAsync: false },
  Print: { provider: 'host', isAsync: false },
  PrintFormat: { provider: 'host', isAsync: false },
  Comment: { provider: 'host', isAsync: false },
  Alert: { provider: 'host', isAsync: false },
  GetLastError: { provider: 'host', isAsync: false },
  ResetLastError: { provider: 'host', isAsync: false },
};

// ─────────────────────────────────────────────────────────────────────────
// CTrade method intrinsics (called as `tradeObj.method(...)`)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Methods on a `CTrade` receiver. `name` is the method name (the emitter
 * produces `receiver.<name>(args)`). Trade-placing methods are async; the
 * configuration setters and last-result accessors are sync.
 */
const CTRADE_METHODS: Record<string, { isAsync: boolean }> = {
  // trading (broker I/O — async)
  Buy: { isAsync: true },
  Sell: { isAsync: true },
  PositionClose: { isAsync: true },
  PositionModify: { isAsync: true },
  PositionOpen: { isAsync: true },
  OrderOpen: { isAsync: true },
  OrderDelete: { isAsync: true },
  OrderModify: { isAsync: true },
  BuyLimit: { isAsync: true },
  SellLimit: { isAsync: true },
  BuyStop: { isAsync: true },
  SellStop: { isAsync: true },

  // configuration (sync — no I/O)
  SetExpertMagicNumber: { isAsync: false },
  SetDeviationInPoints: { isAsync: false },
  SetTypeFilling: { isAsync: false },
  SetTypeFillingBySymbol: { isAsync: false },
  SetMarginMode: { isAsync: false },
  SetAsyncMode: { isAsync: false },
  LogLevel: { isAsync: false },

  // last-result accessors (sync)
  ResultRetcode: { isAsync: false },
  ResultRetcodeDescription: { isAsync: false },
  ResultDeal: { isAsync: false },
  ResultOrder: { isAsync: false },
  ResultVolume: { isAsync: false },
  ResultPrice: { isAsync: false },
  ResultBid: { isAsync: false },
  ResultAsk: { isAsync: false },
  ResultComment: { isAsync: false },
  CheckResultRetcode: { isAsync: false },
  RequestMagic: { isAsync: false },
};

// ─────────────────────────────────────────────────────────────────────────
// Standard-Library classes the runtime provides (`new rt.<Class>(rt, ...)`).
// ─────────────────────────────────────────────────────────────────────────
export const STDLIB_CLASSES: ReadonlySet<string> = new Set([
  'CTrade',
  // Near-neighbour stdlib classes the runtime is expected to grow into. They
  // are recognised as builtin class names so an object decl `CXxx x;` resolves
  // to a runtime construction rather than an unknown user type.
  'CPositionInfo',
  'CSymbolInfo',
  'CAccountInfo',
  'COrderInfo',
  'CDealInfo',
  'CArrayObj',
  'CArrayDouble',
  'CArrayInt',
  'CiMA',
  'CiRSI',
  'CiATR',
  'CiMACD',
  'CiStochastic',
  'CiBands',
]);

// ─────────────────────────────────────────────────────────────────────────
// Context variables, builtin constants.
// ─────────────────────────────────────────────────────────────────────────

/** Predefined runtime context variables (getters on `rt`). */
export const CONTEXT_VARS: ReadonlySet<string> = new Set([
  '_Symbol',
  '_Period',
  '_Digits',
  '_Point',
  '_LastError',
  '_RandomSeed',
  '_StopFlag',
  '_UninitReason',
]);

/** Builtin compile-time constant names — the keys of MQL_CONST. */
export const BUILTIN_CONSTS: ReadonlySet<string> = new Set(Object.keys(MQL_CONST));

// ─────────────────────────────────────────────────────────────────────────
// Public classification API
// ─────────────────────────────────────────────────────────────────────────

/** Look up a free-function intrinsic by name. */
export function lookupFreeIntrinsic(name: string): IntrinsicInfo | undefined {
  const row = FREE_INTRINSICS[name];
  if (!row) return undefined;
  return { provider: row.provider, name, isAsync: row.isAsync };
}

/**
 * Look up a CTrade method intrinsic by method name. The provider is 'broker'
 * for trade ops and 'host' for setters/result accessors (matching the runtime).
 */
export function lookupCTradeMethod(method: string): IntrinsicInfo | undefined {
  const row = CTRADE_METHODS[method];
  if (!row) return undefined;
  return {
    provider: row.isAsync ? 'broker' : 'host',
    name: method,
    isAsync: row.isAsync,
  };
}

/** True if `name` is any recognised free-function builtin. */
export function isFreeIntrinsic(name: string): boolean {
  return name in FREE_INTRINSICS;
}

/** True if `name` is a Standard-Library class the runtime provides. */
export function isStdlibClass(name: string): boolean {
  return STDLIB_CLASSES.has(name);
}

/** True if `name` is a predefined context variable. */
export function isContextVar(name: string): boolean {
  return CONTEXT_VARS.has(name);
}

/** True if `name` is a builtin compile-time constant. */
export function isBuiltinConst(name: string): boolean {
  return BUILTIN_CONSTS.has(name);
}
