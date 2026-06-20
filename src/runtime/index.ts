/**
 * createRuntime — assembles the full `Runtime` surface over the provider
 * boundary. This is what `createExpert(rt, inputs?)` receives.
 *
 *   Runtime = RuntimeApi & MqlConst
 *
 * We spread MQL_CONST (the constants table) onto the object and implement every
 * RuntimeApi member over `providers` + the helper modules (indicators, arrays,
 * positions, CTrade). All reads are sync; only CTrade trade methods are async.
 *
 * Context binding: `_Symbol`/`_Period` come from RuntimeContext; `_Digits` /
 * `_Point` from the feed's symbol spec for the bound symbol.
 *
 * Engine hook: `setContext()` lets the engine driver re-bind the current
 * (symbol, timeframe) if the chart context changes. The "current bar" notion is
 * NOT held in the runtime — it lives in the feed (history()'s last element is
 * the current bar, per engine/types.ts BacktestSimulation invariant). The
 * runtime always reads the feed's latest state, so advancing the backtest one
 * bar is automatically reflected with no runtime mutation needed.
 */

import { MQL_CONST, type MqlConst } from './constants';
import type { Providers } from './providers/types';
import type { RuntimeContext } from '../engine/types';
import type {
  Runtime,
  RuntimeApi,
  CTradeCtor,
  MqlTradeRequestCtor,
  MqlTradeResultCtor,
  MqlTradeCheckResultCtor,
  MqlTradeTransactionCtor,
} from './runtime';
import { IndicatorRegistry } from './indicators/registry';
import { CustomIndicatorRegistry, CUSTOM_HANDLE_BASE } from './indicators/icustom';
import {
  MqlTradeRequest,
  MqlTradeResult,
  MqlTradeCheckResult,
  MqlTradeTransaction,
} from './mqlStructs';
import { orderSend } from './orderSend';
import {
  ArraySeriesRegistry,
  arrayResize,
  arraySize,
  arrayFill,
  arrayInitialize,
} from './arrays';
import { PositionState } from './positions';
import { CTrade } from './ctrade';
import { iBars, iVolume, iHighest, iLowest } from './indicators/series';
import { OrderState, positionGetTicket } from './orders';
import { HistoryState } from './history';
import {
  copyRates,
  copyTickVolume,
  copyRealVolume,
  copySpread,
  symbolInfoString,
  symbolSelect,
  accountInfoString,
  timeGMT,
  timeTradeServer,
  timeToStruct,
  type MqlRates,
  type MqlDateTime,
} from './reads';
import {
  MathAbs,
  MathMax,
  MathMin,
  MathFloor,
  MathCeil,
  MathRound,
  MathSqrt,
  MathPow,
  MathLog,
  MathExp,
  MathSin,
  MathCos,
  MathTan,
  MathMod,
  MathRand,
} from './host/math';
import {
  StringFormat,
  StringLen,
  StringSubstr,
  StringFind,
  StringReplace,
  StringToDouble,
  StringToInteger,
} from './host/str';
import {
  DoubleToString,
  IntegerToString,
  TimeToString,
  PrintFormat,
} from './host/convert';
import {
  ArrayCopy,
  ArrayMaximum,
  ArrayMinimum,
  ArraySort,
} from './host/array';

const INVALID_HANDLE = -1;

/**
 * MT5-style Print: concatenate args with NO separator, numbers/bools/strings
 * stringified MT5-ish. (MT5 doubles print with up to ~16 sig digits; for the
 * PoC we use JS default number→string which is sufficient for logs.)
 */
function mqlStringify(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'boolean') return arg ? 'true' : 'false';
  if (typeof arg === 'number') {
    // MT5's Print formats whole doubles as integers and fractional doubles to
    // 8 decimals by default. Integers print bare; fractional values use up to
    // 8 dp (trailing zeros are part of MT5's format but cosmetic for logs).
    if (Number.isInteger(arg)) return arg.toString();
    return arg.toFixed(8);
  }
  return String(arg);
}

/** The concrete runtime object. Implements RuntimeApi; constants merged in. */
class RuntimeImpl implements RuntimeApi {
  readonly broker;
  readonly feed;
  readonly clock;

  // predefined context vars (mutable-bindable)
  private symbol: string;
  private period: number;
  private digits: number;
  private point: number;
  _LastError = 0;

  // ── timer state (engine hook) ──
  // The configured OnTimer interval in SECONDS. 0 = no timer running. MT5's
  // EventSetTimer takes seconds; EventSetMillisecondTimer takes ms (we store it
  // as fractional seconds). The engine driver reads this via __timerSeconds()
  // to know whether/how often to fire OnTimer. (0 is a valid "no timer" state —
  // §29: we distinguish "0 = killed/never set" from a positive interval.)
  private timerSeconds = 0;

  // helper subsystems
  private readonly seriesReg: ArraySeriesRegistry;
  private readonly indicators: IndicatorRegistry;
  private readonly customIndicators: CustomIndicatorRegistry;
  private readonly positionsState: PositionState;
  private readonly ordersState: OrderState;
  private readonly historyState: HistoryState;
  private readonly C: MqlConst;

  // Monotonic handle counter for custom indicators, OFFSET by CUSTOM_HANDLE_BASE
  // so iCustom handles occupy a numeric range DISJOINT from the native
  // IndicatorRegistry's 0-based handles. `owns()`-based routing (in CopyBuffer /
  // IndicatorRelease) is correct either way; a disjoint range removes any doubt.
  private customHandleCounter = 0;

  readonly CTrade: CTradeCtor;
  // Builtin trade-API struct constructors (assigned as the CLASSES, not
  // instances): `new rt.MqlTradeRequest()` zero-inits a fresh value struct.
  readonly MqlTradeRequest: MqlTradeRequestCtor = MqlTradeRequest;
  readonly MqlTradeResult: MqlTradeResultCtor = MqlTradeResult;
  readonly MqlTradeCheckResult: MqlTradeCheckResultCtor = MqlTradeCheckResult;
  readonly MqlTradeTransaction: MqlTradeTransactionCtor = MqlTradeTransaction;

  constructor(
    providers: Providers,
    ctx: RuntimeContext,
    C: MqlConst,
    indicatorsDir?: string,
  ) {
    this.broker = providers.broker;
    this.feed = providers.feed;
    this.clock = providers.clock;
    this.C = C;

    this.symbol = ctx.symbol;
    this.period = ctx.timeframe;
    const spec = providers.feed.symbolInfo(ctx.symbol);
    this.digits = spec.digits;
    this.point = spec.point;

    this.seriesReg = new ArraySeriesRegistry();
    this.indicators = new IndicatorRegistry(providers.feed, this.seriesReg);
    this.customIndicators = new CustomIndicatorRegistry(
      providers.feed,
      this.seriesReg,
      ctx,
      () => CUSTOM_HANDLE_BASE + this.customHandleCounter++,
      indicatorsDir,
    );
    this.positionsState = new PositionState(providers.broker, C);
    this.ordersState = new OrderState(providers.broker);
    this.historyState = new HistoryState(providers.broker);
    this.CTrade = CTrade as unknown as CTradeCtor;
  }

  // ── predefined context variables (getters) ──
  get _Symbol(): string {
    return this.symbol;
  }
  get _Period(): number {
    return this.period;
  }
  get _Digits(): number {
    return this.digits;
  }
  get _Point(): number {
    return this.point;
  }

  /**
   * Engine hook — re-bind the chart context. Re-reads digits/point from the
   * feed for the new symbol. (Documented in the file header.)
   */
  setContext(ctx: RuntimeContext): void {
    this.symbol = ctx.symbol;
    this.period = ctx.timeframe;
    const spec = this.feed.symbolInfo(ctx.symbol);
    this.digits = spec.digits;
    this.point = spec.point;
  }

  // ── indicators ──
  iMA(
    symbol: string,
    timeframe: number,
    period: number,
    shift: number,
    method: number,
    appliedPrice: number,
  ): number {
    return this.indicators.iMA(
      symbol,
      timeframe,
      period,
      shift,
      method,
      appliedPrice,
    );
  }
  iRSI(symbol: string, timeframe: number, period: number, appliedPrice: number): number {
    return this.indicators.iRSI(symbol, timeframe, period, appliedPrice);
  }
  iATR(symbol: string, timeframe: number, period: number): number {
    return this.indicators.iATR(symbol, timeframe, period);
  }
  iMACD(
    symbol: string,
    timeframe: number,
    fastEma: number,
    slowEma: number,
    signalPeriod: number,
    appliedPrice: number,
  ): number {
    return this.indicators.iMACD(symbol, timeframe, fastEma, slowEma, signalPeriod, appliedPrice);
  }
  iBands(
    symbol: string,
    timeframe: number,
    period: number,
    shift: number,
    deviation: number,
    appliedPrice: number,
  ): number {
    return this.indicators.iBands(symbol, timeframe, period, shift, deviation, appliedPrice);
  }
  iStochastic(
    symbol: string,
    timeframe: number,
    kPeriod: number,
    dPeriod: number,
    slowing: number,
    maMethod: number,
    priceField: number,
  ): number {
    return this.indicators.iStochastic(symbol, timeframe, kPeriod, dPeriod, slowing, maMethod, priceField);
  }
  iADX(symbol: string, timeframe: number, period: number): number {
    return this.indicators.iADX(symbol, timeframe, period);
  }
  iCCI(symbol: string, timeframe: number, period: number, appliedPrice: number): number {
    return this.indicators.iCCI(symbol, timeframe, period, appliedPrice);
  }
  iMomentum(symbol: string, timeframe: number, period: number, appliedPrice: number): number {
    return this.indicators.iMomentum(symbol, timeframe, period, appliedPrice);
  }
  iCustom(
    symbol: string,
    timeframe: number,
    name: string,
    ...params: (number | boolean | string)[]
  ): number {
    return this.customIndicators.iCustom(symbol, timeframe, name, ...params);
  }
  CopyBuffer(
    handle: number,
    bufferNum: number,
    startPos: number,
    count: number,
    dest: number[],
  ): number {
    // Route by handle ownership: a handle minted by iCustom reads from the
    // custom-indicator registry; everything else from the native registry.
    if (this.customIndicators.owns(handle)) {
      return this.customIndicators.copyBuffer(handle, bufferNum, startPos, count, dest);
    }
    return this.indicators.copyBuffer(handle, bufferNum, startPos, count, dest);
  }
  IndicatorRelease(handle: number): boolean {
    if (this.customIndicators.owns(handle)) {
      return this.customIndicators.release(handle);
    }
    return this.indicators.release(handle);
  }

  // ── timeseries ──
  Bars(symbol: string, timeframe: number): number {
    return this.feed.history(symbol, timeframe).length;
  }
  iBars(symbol: string, timeframe: number): number {
    return iBars(this.feed.history(symbol, timeframe));
  }
  private copyPrice(
    symbol: string,
    timeframe: number,
    startPos: number,
    count: number,
    dest: number[],
    pick: (b: import('./providers/types').Bar) => number,
  ): number {
    if (count <= 0 || startPos < 0) return 0;
    const bars = this.feed.history(symbol, timeframe);
    const n = bars.length;
    const newestFirst: number[] = [];
    for (let p = startPos; p < startPos + count; p++) {
      const chrono = n - 1 - p;
      if (chrono < 0) break;
      newestFirst.push(pick(bars[chrono]!));
    }
    const copied = newestFirst.length;
    const asSeries = this.seriesReg.isAsSeries(dest);
    dest.length = copied;
    if (asSeries) {
      for (let i = 0; i < copied; i++) dest[i] = newestFirst[i]!;
    } else {
      for (let i = 0; i < copied; i++) dest[i] = newestFirst[copied - 1 - i]!;
    }
    return copied;
  }
  CopyClose(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return this.copyPrice(s, tf, sp, c, dest, (b) => b.close);
  }
  CopyOpen(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return this.copyPrice(s, tf, sp, c, dest, (b) => b.open);
  }
  CopyHigh(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return this.copyPrice(s, tf, sp, c, dest, (b) => b.high);
  }
  CopyLow(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return this.copyPrice(s, tf, sp, c, dest, (b) => b.low);
  }
  CopyTime(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return this.copyPrice(s, tf, sp, c, dest, (b) => b.time);
  }
  CopyTickVolume(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return copyTickVolume(this.feed, this.seriesReg, s, tf, sp, c, dest);
  }
  CopyRealVolume(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return copyRealVolume(this.feed, this.seriesReg, s, tf, sp, c, dest);
  }
  CopySpread(s: string, tf: number, sp: number, c: number, dest: number[]): number {
    return copySpread(this.feed, this.seriesReg, s, tf, sp, c, dest);
  }
  CopyRates(s: string, tf: number, sp: number, c: number, dest: unknown[]): number {
    // dest holds MqlRates structs; the EA reads rates[i].close etc.
    return copyRates(this.feed, this.seriesReg, s, tf, sp, c, dest as MqlRates[]);
  }

  /** iClose/iOpen/... use shift in as-series direction (0 = current bar). */
  private iPrice(
    symbol: string,
    timeframe: number,
    shift: number,
    pick: (b: import('./providers/types').Bar) => number,
  ): number {
    const bars = this.feed.history(symbol, timeframe);
    const n = bars.length;
    const chrono = n - 1 - shift;
    if (chrono < 0 || chrono >= n) return 0;
    return pick(bars[chrono]!);
  }
  iClose(s: string, tf: number, sh: number): number {
    return this.iPrice(s, tf, sh, (b) => b.close);
  }
  iOpen(s: string, tf: number, sh: number): number {
    return this.iPrice(s, tf, sh, (b) => b.open);
  }
  iHigh(s: string, tf: number, sh: number): number {
    return this.iPrice(s, tf, sh, (b) => b.high);
  }
  iLow(s: string, tf: number, sh: number): number {
    return this.iPrice(s, tf, sh, (b) => b.low);
  }
  iTime(s: string, tf: number, sh: number): number {
    return this.iPrice(s, tf, sh, (b) => b.time);
  }
  iVolume(s: string, tf: number, sh: number): number {
    return iVolume(this.feed.history(s, tf), sh);
  }
  iHighest(s: string, tf: number, type: number, count: number, start: number): number {
    return iHighest(this.feed.history(s, tf), type, count, start);
  }
  iLowest(s: string, tf: number, type: number, count: number, start: number): number {
    return iLowest(this.feed.history(s, tf), type, count, start);
  }

  // ── arrays ──
  ArraySetAsSeries(arr: unknown[], flag: boolean): boolean {
    return this.seriesReg.setAsSeries(arr, flag);
  }
  ArrayGetAsSeries(arr: unknown[]): boolean {
    return this.seriesReg.isAsSeries(arr);
  }
  ArrayResize(arr: unknown[], newSize: number, reserve?: number): number {
    return arrayResize(arr, newSize, reserve);
  }
  ArraySize(arr: unknown[]): number {
    return arraySize(arr);
  }
  ArrayFill(arr: number[], start: number, count: number, value: number): void {
    arrayFill(arr, start, count, value);
  }
  ArrayInitialize(arr: number[], value: number): number {
    return arrayInitialize(arr, value);
  }
  ArrayCopy(
    dst: unknown[],
    src: unknown[],
    dstStart?: number,
    srcStart?: number,
    count?: number,
  ): number {
    return ArrayCopy(dst, src, dstStart, srcStart, count);
  }
  ArrayMaximum(arr: number[], start?: number, count?: number): number {
    // MT5 returns the INDEX in the array's current indexing direction; the
    // host helper is pure, so thread the array's tracked as-series flag in.
    return ArrayMaximum(arr, start, count, this.seriesReg.isAsSeries(arr));
  }
  ArrayMinimum(arr: number[], start?: number, count?: number): number {
    return ArrayMinimum(arr, start, count, this.seriesReg.isAsSeries(arr));
  }
  ArraySort(arr: number[]): boolean {
    return ArraySort(arr);
  }

  // ── positions ──
  PositionSelect(symbol: string): boolean {
    return this.positionsState.select(symbol);
  }
  PositionSelectByTicket(ticket: number): boolean {
    return this.positionsState.selectByTicket(ticket);
  }
  PositionsTotal(): number {
    return this.positionsState.total();
  }
  PositionGetSymbol(index: number): string {
    return this.positionsState.getSymbol(index);
  }
  PositionGetInteger(property: number): number {
    return this.positionsState.getInteger(property);
  }
  PositionGetDouble(property: number): number {
    return this.positionsState.getDouble(property);
  }
  PositionGetString(property: number): string {
    return this.positionsState.getString(property);
  }
  /**
   * PositionGetTicket(index) — ticket of the open position at `index`, AND
   * selects it (MT5 select-by-index), so a following PositionGet* reads it.
   * Returns 0 on out-of-range. The select is threaded through PositionState
   * (which owns the selected-position cursor) via selectByTicket.
   */
  PositionGetTicket(index: number): number {
    const ticket = positionGetTicket(this.broker, index);
    if (ticket !== 0) this.positionsState.selectByTicket(ticket);
    return ticket;
  }

  // ── pending orders (trading pool; implicit selected-order cursor) ──
  OrdersTotal(): number {
    return this.ordersState.total();
  }
  OrderGetTicket(index: number): number {
    return this.ordersState.getTicket(index);
  }
  OrderSelect(ticket: number): boolean {
    return this.ordersState.select(ticket);
  }
  OrderGetInteger(property: number): number {
    return this.ordersState.getInteger(property);
  }
  OrderGetDouble(property: number): number {
    return this.ordersState.getDouble(property);
  }
  OrderGetString(property: number): string {
    return this.ordersState.getString(property);
  }

  // ── history (closed deals; selected-window state) ──
  HistorySelect(from: number, to: number): boolean {
    return this.historyState.select(from, to);
  }
  HistoryDealsTotal(): number {
    return this.historyState.dealsTotal();
  }
  HistoryDealGetTicket(index: number): number {
    return this.historyState.dealGetTicket(index);
  }
  HistoryDealGetInteger(ticket: number, property: number): number {
    return this.historyState.dealGetInteger(ticket, property);
  }
  HistoryDealGetDouble(ticket: number, property: number): number {
    return this.historyState.dealGetDouble(ticket, property);
  }
  HistoryDealGetString(ticket: number, property: number): string {
    return this.historyState.dealGetString(ticket, property);
  }

  // ── account ──
  AccountInfoDouble(property: number): number {
    const a = this.broker.account();
    const C = this.C;
    switch (property) {
      case C.ACCOUNT_BALANCE:
        return a.balance;
      case C.ACCOUNT_EQUITY:
        return a.equity;
      case C.ACCOUNT_MARGIN:
        return a.margin;
      case C.ACCOUNT_MARGIN_FREE:
        return a.freeMargin;
      case C.ACCOUNT_PROFIT:
        // Floating profit = equity - balance in the netting model.
        return a.equity - a.balance;
      default:
        throw new Error(`AccountInfoDouble: unsupported property id ${property}`);
    }
  }
  AccountInfoInteger(property: number): number {
    const a = this.broker.account();
    const C = this.C;
    switch (property) {
      case C.ACCOUNT_LOGIN:
        return a.login;
      case C.ACCOUNT_LEVERAGE:
        return a.leverage;
      default:
        throw new Error(`AccountInfoInteger: unsupported property id ${property}`);
    }
  }
  AccountInfoString(property: number): string {
    // Real (honest-partial) impl: answers ACCOUNT_CURRENCY from the boundary;
    // other string properties throw (the boundary doesn't carry company/name/
    // server) rather than fabricating a broker name (§21). See reads.ts.
    return accountInfoString(this.broker, property);
  }

  // ── symbol ──
  SymbolInfoDouble(symbol: string, property: number): number {
    const spec = this.feed.symbolInfo(symbol);
    const C = this.C;
    switch (property) {
      case C.SYMBOL_BID:
        return this.feed.tick(symbol).bid;
      case C.SYMBOL_ASK:
        return this.feed.tick(symbol).ask;
      case C.SYMBOL_POINT:
        return spec.point;
      case C.SYMBOL_VOLUME_MIN:
        return spec.volumeMin;
      case C.SYMBOL_VOLUME_MAX:
        return spec.volumeMax;
      case C.SYMBOL_VOLUME_STEP:
        return spec.volumeStep;
      case C.SYMBOL_TRADE_TICK_VALUE:
        return spec.tickValue;
      case C.SYMBOL_TRADE_TICK_SIZE:
        return spec.tickSize;
      case C.SYMBOL_TRADE_CONTRACT_SIZE:
        return spec.contractSize;
      default:
        throw new Error(`SymbolInfoDouble: unsupported property id ${property}`);
    }
  }
  SymbolInfoInteger(symbol: string, property: number): number {
    const spec = this.feed.symbolInfo(symbol);
    const C = this.C;
    switch (property) {
      case C.SYMBOL_DIGITS:
        return spec.digits;
      default:
        throw new Error(`SymbolInfoInteger: unsupported property id ${property}`);
    }
  }
  SymbolInfoString(symbol: string, property: number): string {
    // Real (honest-partial) impl: answers SYMBOL_NAME/SYMBOL_DESCRIPTION from
    // the boundary; other string properties throw (the boundary's SymbolSpec
    // carries only `name`) rather than fabricating a currency code (§21).
    return symbolInfoString(this.feed, symbol, property);
  }
  SymbolInfoTick(symbol: string, tick: unknown): boolean {
    // Fill the supplied MqlTick-like object with the current tick. The emitted
    // code passes a plain object; we mutate it in place.
    const t = this.feed.tick(symbol);
    if (tick && typeof tick === 'object') {
      Object.assign(tick as Record<string, unknown>, {
        time: t.time,
        bid: t.bid,
        ask: t.ask,
        last: t.last,
        volume: t.volume,
      });
      return true;
    }
    return false;
  }
  SymbolSelect(symbol: string, enable: boolean): boolean {
    return symbolSelect(this.feed, symbol, enable);
  }

  // ── raw trade API (broker I/O — async) ──
  /**
   * OrderSend — forward to the orderSend module bound to this runtime's broker.
   * It dispatches on `request.action`, performs the broker op, and mutates
   * `result` in place (see ./orderSend.ts). Returns retcode === DONE.
   */
  OrderSend(request: MqlTradeRequest, result: MqlTradeResult): Promise<boolean> {
    return orderSend(this.broker, request, result);
  }

  // ── timer (host) ──
  /**
   * MT5 EventSetTimer(seconds): start the OnTimer timer. Returns true on
   * success. MT5 requires a positive interval; a non-positive/non-finite value
   * is rejected (returns false) and leaves any running timer untouched.
   */
  EventSetTimer(seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    this.timerSeconds = seconds;
    return true;
  }
  /**
   * MT5 EventSetMillisecondTimer(milliseconds): start a high-resolution timer.
   * We store the interval as fractional seconds so __timerSeconds() reports a
   * single unit. Returns true on success.
   */
  EventSetMillisecondTimer(milliseconds: number): boolean {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return false;
    this.timerSeconds = milliseconds / 1000;
    return true;
  }
  /** MT5 EventKillTimer(): stop the timer (interval → 0). */
  EventKillTimer(): void {
    this.timerSeconds = 0;
  }
  /**
   * ENGINE-INTERNAL (not an MQL5 builtin): the currently-configured timer
   * interval in seconds, 0 when no timer is running. The backtest driver polls
   * this after OnInit to drive OnTimer at the right cadence.
   */
  __timerSeconds(): number {
    return this.timerSeconds;
  }

  // ── time ──
  TimeCurrent(): number {
    return this.clock.now();
  }
  TimeLocal(): number {
    return this.clock.now();
  }
  TimeTradeServer(): number {
    return timeTradeServer(this.clock);
  }
  TimeGMT(): number {
    return timeGMT(this.clock);
  }
  TimeToStruct(datetime: number, out: unknown): boolean {
    // The EA passes an MqlDateTime-shaped object by reference; mutate in place.
    return timeToStruct(datetime, out as MqlDateTime);
  }

  // ── normalization / host helpers ──
  NormalizeDouble(value: number, digits: number): number {
    // MT5 NormalizeDouble rounds to `digits` decimals, round-half-away-from-zero
    // (MT5 uses standard rounding). Implement with the scaled-round approach,
    // guarding against negative/oversized digit counts (MT5 clamps 0..8).
    const d = Math.max(0, Math.min(8, Math.trunc(digits)));
    if (!Number.isFinite(value)) return value;
    const factor = Math.pow(10, d);
    // round half away from zero
    const scaled = value * factor;
    const rounded =
      scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
    return rounded / factor;
  }
  Print(...args: unknown[]): void {
    process.stdout.write(args.map(mqlStringify).join('') + '\n');
  }
  Comment(...args: unknown[]): void {
    // MT5 Comment writes to the chart; for the PoC route to stdout, prefixed.
    process.stdout.write('[Comment] ' + args.map(mqlStringify).join('') + '\n');
  }
  Alert(...args: unknown[]): void {
    process.stdout.write('[Alert] ' + args.map(mqlStringify).join('') + '\n');
  }
  GetLastError(): number {
    return this._LastError;
  }
  ResetLastError(): void {
    this._LastError = 0;
  }

  // ── Math* host helpers (pure; MT5-exact — see ./host/math.ts) ──
  MathAbs(x: number): number {
    return MathAbs(x);
  }
  MathMax(a: number, b: number): number {
    return MathMax(a, b);
  }
  MathMin(a: number, b: number): number {
    return MathMin(a, b);
  }
  MathFloor(x: number): number {
    return MathFloor(x);
  }
  MathCeil(x: number): number {
    return MathCeil(x);
  }
  MathRound(x: number): number {
    return MathRound(x);
  }
  MathSqrt(x: number): number {
    return MathSqrt(x);
  }
  MathPow(base: number, exponent: number): number {
    return MathPow(base, exponent);
  }
  MathLog(x: number): number {
    return MathLog(x);
  }
  MathExp(x: number): number {
    return MathExp(x);
  }
  MathSin(x: number): number {
    return MathSin(x);
  }
  MathCos(x: number): number {
    return MathCos(x);
  }
  MathTan(x: number): number {
    return MathTan(x);
  }
  MathMod(a: number, b: number): number {
    return MathMod(a, b);
  }
  MathRand(): number {
    return MathRand();
  }

  // ── String* + conversion host helpers (pure; MT5-exact — see ./host/*) ──
  StringFormat(format: string, ...args: unknown[]): string {
    return StringFormat(format, ...args);
  }
  StringLen(s: string): number {
    return StringLen(s);
  }
  StringSubstr(text: string, start: number, length?: number): string {
    return StringSubstr(text, start, length);
  }
  StringFind(text: string, match: string, start?: number): number {
    return StringFind(text, match, start);
  }
  StringReplace(text: string, find: string, replacement: string): string {
    return StringReplace(text, find, replacement);
  }
  StringToDouble(text: string): number {
    return StringToDouble(text);
  }
  StringToInteger(text: string): number {
    return StringToInteger(text);
  }
  DoubleToString(value: number, digits?: number): string {
    // The helper returns `number | string` for a documented edge; MT5's
    // DoubleToString is always a string — coerce so the ABI type holds.
    return String(DoubleToString(value, digits));
  }
  IntegerToString(value: number, strLen?: number, fillSymbol?: number | string): string {
    return IntegerToString(value, strLen, fillSymbol);
  }
  TimeToString(datetime: number, flags?: number): string {
    return TimeToString(datetime, flags);
  }
  PrintFormat(format: string, ...args: unknown[]): void {
    PrintFormat(format, ...args);
  }
}

/** Options for createRuntime (all optional; additive). */
export interface CreateRuntimeOptions {
  /**
   * Directory `iCustom("<name>")` resolves `<name>.mq5` against. When omitted,
   * the custom-indicator compiler uses its default (`examples/indicators`). An
   * absolute/relative `.mq5` path in the `name` arg is also accepted directly.
   */
  indicatorsDir?: string;
}

/**
 * Build the full Runtime: a RuntimeImpl with the constants table merged on.
 * The constants are own-enumerable data props so `rt.MODE_SMA` resolves.
 */
export function createRuntime(
  providers: Providers,
  ctx: RuntimeContext,
  opts?: CreateRuntimeOptions,
): Runtime {
  const impl = new RuntimeImpl(providers, ctx, MQL_CONST, opts?.indicatorsDir);
  // Merge the constants table as own properties (non-enumerable not required;
  // the emitter only reads them). Object.assign copies the const values.
  Object.assign(impl, MQL_CONST);
  return impl as unknown as Runtime;
}

export { INVALID_HANDLE };
export { RuntimeImpl };
// Additive re-export: the runtime's honest capability surface + the coverage
// checker, so callers (CLIs, tooling, tests) reach them from the runtime barrel.
export { RUNTIME_COVERAGE, checkCoverage } from './coverage';
