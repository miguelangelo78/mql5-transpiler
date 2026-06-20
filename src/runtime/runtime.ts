/**
 * The Runtime (`rt`) — the emission ABI surface.
 *
 * The transpiled EA is a factory `createExpert(rt: Runtime, inputs?)`. Every
 * MQL5 builtin, predefined variable, constant, and Standard-Library class the
 * program uses is reached through `rt`. The TypeScript backend emits against
 * this interface; the runtime package implements it over the provider boundary
 * (./providers/types.ts). Keeping this as the single shared type is what lets
 * the emitter and the runtime be built independently and still interlock.
 *
 *   Runtime = RuntimeApi & MqlConst
 *     RuntimeApi  — context vars, builtin functions, Standard-Library classes
 *     MqlConst    — the constants table (./constants.ts)
 *
 * Async rule (mirrors ../ir/nodes.ts): only the order-placing CTrade / trade
 * methods are async (`Promise`). Indicators, copies, position/account/symbol
 * reads, and array/math/string helpers are synchronous.
 *
 * This surface is deliberately scoped to the PoC sample EA plus near neighbours
 * and is expected to GROW. Adding a builtin = extend RuntimeApi + implement it.
 */

import type { IBroker, IMarketFeed, IClock } from './providers/types';
import type { MqlConst } from './constants';

/** MT5 `CTrade` Standard-Library class (subset). Trade ops are async. */
export interface ICTrade {
  // configuration (sync)
  SetExpertMagicNumber(magic: number): void;
  SetDeviationInPoints(points: number): void;
  SetTypeFilling(filling: number): void;
  LogLevel(level: number): void;

  // trading (async — broker I/O)
  Buy(volume: number, symbol?: string, price?: number, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  Sell(volume: number, symbol?: string, price?: number, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  PositionClose(symbolOrTicket: string | number, deviation?: number): Promise<boolean>;
  PositionModify(symbolOrTicket: string | number, sl: number, tp: number): Promise<boolean>;

  // pending orders (async — broker I/O). Optional: a runtime built over an
  // egress that doesn't support pending orders may omit these; CTrade reports
  // honestly rather than faking success.
  BuyLimit?(volume: number, price: number, symbol?: string, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  SellLimit?(volume: number, price: number, symbol?: string, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  BuyStop?(volume: number, price: number, symbol?: string, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  SellStop?(volume: number, price: number, symbol?: string, sl?: number, tp?: number, comment?: string): Promise<boolean>;
  OrderDelete?(ticket: number): Promise<boolean>;

  // last-result accessors (sync)
  ResultRetcode(): number;
  ResultRetcodeDescription(): string;
  ResultDeal(): number;
  ResultOrder(): number;
  ResultVolume(): number;
  ResultPrice(): number;
}

export type CTradeCtor = new (rt: Runtime) => ICTrade;

/** The non-constant part of the runtime surface. */
export interface RuntimeApi {
  // ── providers (escape hatch for advanced builtins / engine glue) ──
  readonly broker: IBroker;
  readonly feed: IMarketFeed;
  readonly clock: IClock;

  // ── predefined context variables ──
  readonly _Symbol: string;
  readonly _Period: number;
  readonly _Digits: number;
  readonly _Point: number;
  _LastError: number;

  // ── timer (host) ──
  /** Start the OnTimer timer at `seconds` resolution. The engine driver reads
   *  the configured interval via __timerSeconds() to know when to fire OnTimer. */
  EventSetTimer?(seconds: number): boolean;
  /** Start the OnTimer timer at `millis` resolution. */
  EventSetMillisecondTimer?(millis: number): boolean;
  /** Stop the timer. */
  EventKillTimer?(): void;
  /** ENGINE-INTERNAL (not an MQL5 builtin, never emitted by the backend): the
   *  currently-configured timer interval in seconds (0 = no timer). The backtest
   *  driver polls this after OnInit to drive OnTimer at the right cadence. */
  __timerSeconds?(): number;

  // ── indicators (sync; computed locally from feed candles) ──
  iMA(symbol: string, timeframe: number, period: number, shift: number, method: number, appliedPrice: number): number;
  iRSI(symbol: string, timeframe: number, period: number, appliedPrice: number): number;
  iATR(symbol: string, timeframe: number, period: number): number;
  iMACD(symbol: string, timeframe: number, fastEma: number, slowEma: number, signalPeriod: number, appliedPrice: number): number;
  iBands(symbol: string, timeframe: number, period: number, shift: number, deviation: number, appliedPrice: number): number;
  iStochastic(symbol: string, timeframe: number, kPeriod: number, dPeriod: number, slowing: number, maMethod: number, priceField: number): number;
  iADX(symbol: string, timeframe: number, period: number): number;
  iCCI(symbol: string, timeframe: number, period: number, appliedPrice: number): number;
  iMomentum(symbol: string, timeframe: number, period: number, appliedPrice: number): number;
  CopyBuffer(handle: number, bufferNum: number, startPos: number, count: number, dest: number[]): number;
  IndicatorRelease(handle: number): boolean;

  // ── timeseries (sync) ──
  Bars(symbol: string, timeframe: number): number;
  iBars(symbol: string, timeframe: number): number;
  CopyClose(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyOpen(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyHigh(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyLow(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyTime(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyTickVolume(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyRealVolume(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopySpread(symbol: string, timeframe: number, startPos: number, count: number, dest: number[]): number;
  CopyRates(symbol: string, timeframe: number, startPos: number, count: number, dest: unknown[]): number;
  iClose(symbol: string, timeframe: number, shift: number): number;
  iOpen(symbol: string, timeframe: number, shift: number): number;
  iHigh(symbol: string, timeframe: number, shift: number): number;
  iLow(symbol: string, timeframe: number, shift: number): number;
  iTime(symbol: string, timeframe: number, shift: number): number;
  iVolume(symbol: string, timeframe: number, shift: number): number;
  iHighest(symbol: string, timeframe: number, type: number, count: number, start: number): number;
  iLowest(symbol: string, timeframe: number, type: number, count: number, start: number): number;

  // ── arrays (sync; as-series tracked by array identity) ──
  ArraySetAsSeries(arr: unknown[], flag: boolean): boolean;
  ArrayGetAsSeries(arr: unknown[]): boolean;
  ArrayResize(arr: unknown[], newSize: number, reserve?: number): number;
  ArraySize(arr: unknown[]): number;
  ArrayFill(arr: number[], start: number, count: number, value: number): void;
  ArrayInitialize(arr: number[], value: number): number;
  ArrayCopy(dst: unknown[], src: unknown[], dstStart?: number, srcStart?: number, count?: number): number;
  ArrayMaximum(arr: number[], start?: number, count?: number): number;
  ArrayMinimum(arr: number[], start?: number, count?: number): number;
  ArraySort(arr: number[]): boolean;

  // ── positions (sync reads; MT5's implicit selected-position state) ──
  PositionSelect(symbol: string): boolean;
  PositionSelectByTicket(ticket: number): boolean;
  PositionsTotal(): number;
  PositionGetSymbol(index: number): string;
  PositionGetTicket(index: number): number;
  PositionGetInteger(property: number): number;
  PositionGetDouble(property: number): number;
  PositionGetString(property: number): string;

  // ── pending orders (sync reads; MT5's implicit selected-order cursor) ──
  OrdersTotal(): number;
  OrderGetTicket(index: number): number;
  OrderSelect(ticket: number): boolean;
  OrderGetInteger(property: number): number;
  OrderGetDouble(property: number): number;
  OrderGetString(property: number): string;

  // ── history (closed deals; selected-window state) ──
  HistorySelect(from: number, to: number): boolean;
  HistoryDealsTotal(): number;
  HistoryDealGetTicket(index: number): number;
  HistoryDealGetInteger(ticket: number, property: number): number;
  HistoryDealGetDouble(ticket: number, property: number): number;
  HistoryDealGetString(ticket: number, property: number): string;

  // ── account (sync) ──
  AccountInfoDouble(property: number): number;
  AccountInfoInteger(property: number): number;
  AccountInfoString(property: number): string;

  // ── symbol (sync) ──
  SymbolInfoDouble(symbol: string, property: number): number;
  SymbolInfoInteger(symbol: string, property: number): number;
  SymbolInfoString(symbol: string, property: number): string;
  SymbolInfoTick(symbol: string, tick: unknown): boolean;
  SymbolSelect(symbol: string, enable: boolean): boolean;

  // ── time (sync) ──
  TimeCurrent(): number;
  TimeLocal(): number;
  TimeTradeServer(): number;
  TimeGMT(): number;
  TimeToStruct(datetime: number, out: unknown): boolean;

  // ── normalization / host helpers (sync) ──
  NormalizeDouble(value: number, digits: number): number;
  Print(...args: unknown[]): void;
  Comment(...args: unknown[]): void;
  Alert(...args: unknown[]): void;
  GetLastError(): number;
  ResetLastError(): void;

  // ── Math* host helpers (sync; pure, MT5-exact) ──
  MathAbs(x: number): number;
  MathMax(a: number, b: number): number;
  MathMin(a: number, b: number): number;
  MathFloor(x: number): number;
  MathCeil(x: number): number;
  MathRound(x: number): number;
  MathSqrt(x: number): number;
  MathPow(base: number, exponent: number): number;
  MathLog(x: number): number;
  MathExp(x: number): number;
  MathSin(x: number): number;
  MathCos(x: number): number;
  MathTan(x: number): number;
  MathMod(a: number, b: number): number;
  MathRand(): number;

  // ── String* + conversion host helpers (sync; pure, MT5-exact) ──
  StringFormat(format: string, ...args: unknown[]): string;
  StringLen(s: string): number;
  StringSubstr(text: string, start: number, length?: number): string;
  StringFind(text: string, match: string, start?: number): number;
  StringReplace(text: string, find: string, replacement: string): string;
  StringToDouble(text: string): number;
  StringToInteger(text: string): number;
  DoubleToString(value: number, digits?: number): string;
  IntegerToString(value: number, strLen?: number, fillSymbol?: number | string): string;
  TimeToString(datetime: number, flags?: number): string;
  PrintFormat(format: string, ...args: unknown[]): void;

  // ── Standard-Library classes ──
  readonly CTrade: CTradeCtor;
}

/** The complete runtime surface seen by transpiled programs. */
export type Runtime = RuntimeApi & MqlConst;

/** Inputs override map passed to the emitted factory. */
export type Inputs = Record<string, number | boolean | string>;

/** The shape every emitted EA factory returns. */
export interface ExpertInstance {
  OnInit?: () => Promise<number> | number;
  OnDeinit?: (reason: number) => Promise<void> | void;
  OnTick?: () => Promise<void> | void;
  OnTimer?: () => Promise<void> | void;
  OnTrade?: () => Promise<void> | void;
  OnStart?: () => Promise<void> | void;
  /** The resolved input values actually in effect (defaults ∪ overrides). */
  __inputs: Inputs;
}

export type ExpertFactory = (rt: Runtime, inputs?: Inputs) => ExpertInstance;
