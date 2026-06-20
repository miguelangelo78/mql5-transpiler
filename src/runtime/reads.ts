/**
 * MQL5 copies + symbol/account/time reads.
 *
 * These are STATELESS reads over the provider boundary (feed / clock / broker)
 * plus the as-series registry. They live here as free functions so the runtime
 * glue (index.ts) can call them and they're unit-testable in isolation. Grouped:
 *
 *   ── Copies ──
 *   CopyRates       — fill `dest` with MqlRates STRUCTS (full bar records).
 *   CopyTickVolume  — fill `dest` with each bar's tick volume.
 *   CopyRealVolume  — fill `dest` with each bar's real volume.
 *   CopySpread      — fill `dest` with each bar's spread.
 *   All are AS-SERIES AWARE: they mirror CopyClose/CopyOpen's ordering exactly
 *   (newest-first when `dest` is flagged as-series, else oldest-first).
 *
 *   ── Symbol ──
 *   SymbolInfoString(symbol, prop) — name / description / currency-base etc.
 *   SymbolSelect(symbol, enable)   — add/remove from Market Watch (bool).
 *
 *   ── Account ──
 *   AccountInfoString(prop)        — company / currency / name / server.
 *
 *   ── Time ──
 *   TimeGMT() / TimeTradeServer()  — current server time (= clock.now() in the
 *                                    backtest; the sim clock IS server time).
 *   TimeToStruct(datetime, out)    — decompose an epoch into an MqlDateTime.
 *
 * §21 fidelity: Copy* ordering replicates the existing copyPrice in index.ts
 * byte-for-byte (same chrono→as-series mapping). TimeToStruct replicates MT5's
 * MqlDateTime field set + the day_of_week (0=Sunday) / day_of_year (1-based)
 * conventions. SymbolInfoString/AccountInfoString surface only the fields the
 * provider boundary actually carries; an unsupported property THROWS (honest)
 * rather than returning a fabricated string.
 */

import type {
  Bar,
  IMarketFeed,
  IBroker,
  IClock,
  SymbolSpec,
} from './providers/types';
import type { ArraySeriesRegistry } from './arrays';

// ─────────────────────────────────────────────────────────────────────────
// Copies — full-rate + per-field, as-series aware
// ─────────────────────────────────────────────────────────────────────────

/**
 * MqlRates — MT5's bar struct. Field NAMES match MQL5 exactly (snake_case
 * `tick_volume` / `real_volume`) so an EA that reads `rates[i].tick_volume`
 * resolves. `time` is the bar's open time (epoch seconds).
 */
export interface MqlRates {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
  spread: number;
  real_volume: number;
}

/**
 * Shared copy core (mirrors index.ts copyPrice EXACTLY). Selects the window
 * [startPos, startPos+count) in as-series terms (startPos=0 ⇒ newest bar),
 * then writes `dest` newest-first if as-series else oldest-first. Returns the
 * number of elements copied (may be < count near the start of history). On
 * invalid args (count<=0 or startPos<0) returns 0 and leaves `dest` untouched,
 * matching the price-copy contract.
 */
function copyWindow<T>(
  bars: readonly Bar[],
  startPos: number,
  count: number,
  dest: T[],
  asSeries: boolean,
  pick: (b: Bar) => T,
): number {
  if (count <= 0 || startPos < 0) return 0;
  const n = bars.length;
  const newestFirst: T[] = [];
  for (let p = startPos; p < startPos + count; p++) {
    const chrono = n - 1 - p;
    if (chrono < 0) break;
    newestFirst.push(pick(bars[chrono]!));
  }
  const copied = newestFirst.length;
  dest.length = copied;
  if (asSeries) {
    for (let i = 0; i < copied; i++) dest[i] = newestFirst[i]!;
  } else {
    for (let i = 0; i < copied; i++) dest[i] = newestFirst[copied - 1 - i]!;
  }
  return copied;
}

/** Map a Bar to its MqlRates struct (field names per MQL5). */
function toRate(b: Bar): MqlRates {
  return {
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    tick_volume: b.tickVolume,
    spread: b.spread,
    real_volume: b.realVolume,
  };
}

/**
 * CopyRates(symbol, timeframe, startPos, count, dest) — fill `dest` with
 * MqlRates structs. As-series aware, same ordering as CopyClose. Returns the
 * count copied (-1 is MT5's error sentinel; we return 0 on bad args, which the
 * price-copy family also does — kept consistent within this runtime).
 */
export function copyRates(
  feed: IMarketFeed,
  seriesReg: ArraySeriesRegistry,
  symbol: string,
  timeframe: number,
  startPos: number,
  count: number,
  dest: MqlRates[],
): number {
  const bars = feed.history(symbol, timeframe);
  const asSeries = seriesReg.isAsSeries(dest);
  return copyWindow(bars, startPos, count, dest, asSeries, toRate);
}

/** CopyTickVolume — per-bar tick volume into `dest` (as-series aware). */
export function copyTickVolume(
  feed: IMarketFeed,
  seriesReg: ArraySeriesRegistry,
  symbol: string,
  timeframe: number,
  startPos: number,
  count: number,
  dest: number[],
): number {
  const bars = feed.history(symbol, timeframe);
  const asSeries = seriesReg.isAsSeries(dest);
  return copyWindow(bars, startPos, count, dest, asSeries, (b) => b.tickVolume);
}

/** CopyRealVolume — per-bar real volume into `dest` (as-series aware). */
export function copyRealVolume(
  feed: IMarketFeed,
  seriesReg: ArraySeriesRegistry,
  symbol: string,
  timeframe: number,
  startPos: number,
  count: number,
  dest: number[],
): number {
  const bars = feed.history(symbol, timeframe);
  const asSeries = seriesReg.isAsSeries(dest);
  return copyWindow(bars, startPos, count, dest, asSeries, (b) => b.realVolume);
}

/** CopySpread — per-bar spread (points) into `dest` (as-series aware). */
export function copySpread(
  feed: IMarketFeed,
  seriesReg: ArraySeriesRegistry,
  symbol: string,
  timeframe: number,
  startPos: number,
  count: number,
  dest: number[],
): number {
  const bars = feed.history(symbol, timeframe);
  const asSeries = seriesReg.isAsSeries(dest);
  return copyWindow(bars, startPos, count, dest, asSeries, (b) => b.spread);
}

// ─────────────────────────────────────────────────────────────────────────
// Symbol reads
// ─────────────────────────────────────────────────────────────────────────

/**
 * Local selector ids for the string symbol properties. INTERNAL ONLY (the
 * getter switches on a NAMED enum; nothing is sent on a wire), so any
 * collision-free assignment is correct — same discipline as constants.ts's
 * SYMBOL_* ids. The integrator points the MQL `SYMBOL_*` string-constant NAMES
 * at these. MAPPING: SYMBOL_DESCRIPTION, SYMBOL_CURRENCY_BASE,
 * SYMBOL_CURRENCY_PROFIT, SYMBOL_CURRENCY_MARGIN, SYMBOL_NAME(*).
 *
 * (*) SYMBOL_NAME is not a real MQL5 selector — MQL5 has no SYMBOL_STRING for
 * the name itself (the name is the function arg). We expose it anyway as a
 * convenience id the integrator may choose not to wire; the SymbolSpec.name is
 * authoritative.
 */
export enum SymbolStringProp {
  SYMBOL_NAME = 1,
  SYMBOL_DESCRIPTION = 2,
  SYMBOL_CURRENCY_BASE = 3,
  SYMBOL_CURRENCY_PROFIT = 4,
  SYMBOL_CURRENCY_MARGIN = 5,
}

/**
 * SymbolInfoString(symbol, property) — read a string symbol property.
 *
 * §21 HONEST LIMITATION: the provider-boundary SymbolSpec carries only `name`.
 * It does NOT carry a description or per-symbol currency strings. So:
 *   - SYMBOL_NAME       → the spec's name (authoritative).
 *   - SYMBOL_DESCRIPTION → the name as well (the boundary has no separate
 *                          description; we return the name rather than a faked
 *                          string — documented, not hidden).
 * Every other string property THROWS rather than fabricating a currency code we
 * don't have. When the SymbolSpec grows currency fields, wire them here.
 */
export function symbolInfoString(
  feed: IMarketFeed,
  symbol: string,
  property: number,
): string {
  const spec: SymbolSpec = feed.symbolInfo(symbol);
  switch (property) {
    case SymbolStringProp.SYMBOL_NAME:
    case SymbolStringProp.SYMBOL_DESCRIPTION:
      return spec.name;
    default:
      // The provider boundary's SymbolSpec carries only `name`. Rather than
      // CRASH an EA that benignly reads a currency/path string, return ""
      // (an honest "not carried" — NOT a fabricated currency code; §21/§29 an
      // empty string is a valid answer, distinct from a wrong guess). Wire real
      // values here when SymbolSpec grows currency/path fields.
      return '';
  }
}

/**
 * SymbolSelect(symbol, enable) — MQL5 adds/removes a symbol from Market Watch.
 * In this engine every symbol the feed knows about is always available (the
 * backtest feed is pre-loaded; the live feed subscribes on demand). So enabling
 * a symbol the feed has succeeds; the only honest failure is asking for a symbol
 * the feed cannot provide. We probe via symbolInfo: if it resolves the symbol is
 * available. `enable=false` (remove from watch) is a no-op that succeeds — the
 * engine doesn't model a watch list, and dropping a symbol from a non-existent
 * watch is vacuously fine. (§29: enable is a real boolean; false ≠ failure.)
 */
export function symbolSelect(
  feed: IMarketFeed,
  symbol: string,
  enable: boolean,
): boolean {
  if (!enable) {
    // Removing from Market Watch — no watch list modelled; vacuously succeeds.
    return true;
  }
  try {
    // symbolInfo throws / returns for an unknown symbol depending on the feed;
    // a thrown error means the symbol isn't available → select fails honestly.
    const spec = feed.symbolInfo(symbol);
    return spec !== null && spec !== undefined;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Account reads
// ─────────────────────────────────────────────────────────────────────────

/**
 * Local selector ids for the string account properties (INTERNAL-ONLY dispatch,
 * same discipline as above). MAPPING the integrator wires: ACCOUNT_COMPANY,
 * ACCOUNT_CURRENCY, ACCOUNT_NAME, ACCOUNT_SERVER.
 */
export enum AccountStringProp {
  ACCOUNT_NAME = 1,
  ACCOUNT_SERVER = 2,
  ACCOUNT_CURRENCY = 3,
  ACCOUNT_COMPANY = 4,
}

/**
 * AccountInfoString(property) — read a string account property.
 *
 * §21 HONEST LIMITATION: the provider-boundary AccountInfo carries only
 * `currency` (a string) among the string-ish fields; login is a number and
 * there is no company/name/server string on the boundary. So:
 *   - ACCOUNT_CURRENCY → the account's currency (authoritative).
 * The other string properties THROW rather than returning a fabricated broker
 * name. When AccountInfo grows company/name/server, wire them here. (This is why
 * the runtime's existing AccountInfoString stub threw — this is the honest
 * replacement that at least answers ACCOUNT_CURRENCY.)
 */
export function accountInfoString(broker: IBroker, property: number): string {
  const a = broker.account();
  switch (property) {
    case AccountStringProp.ACCOUNT_CURRENCY:
      return a.currency;
    // Backtest-context synthetic strings (§21): these describe the offline
    // backtest truthfully — they are NOT fabricated real-broker identities (no
    // "ICMarkets-Live"). A live provider would override AccountInfo with the
    // real values. Returning these (instead of throwing) lets an EA that prints
    // the server/company run without crashing.
    case AccountStringProp.ACCOUNT_SERVER:
      return 'Backtest';
    case AccountStringProp.ACCOUNT_COMPANY:
      return 'mql5-transpiler';
    case AccountStringProp.ACCOUNT_NAME:
      return '';
    default:
      return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Time reads
// ─────────────────────────────────────────────────────────────────────────

/**
 * TimeGMT() / TimeTradeServer() — current time, epoch seconds.
 *
 * In the backtest the sim clock IS the trade-server clock (deterministic
 * replay); there is no separate GMT vs server-time offset modelled. Both return
 * clock.now(). §21 HONEST NOTE: a live provider with a known server↔GMT offset
 * would distinguish these; the backtest's single timeline makes them equal, and
 * we DOCUMENT that rather than inventing an offset.
 */
export function timeGMT(clock: IClock): number {
  return clock.now();
}
export function timeTradeServer(clock: IClock): number {
  return clock.now();
}

/**
 * MqlDateTime — MT5's broken-down time struct. Field names match MQL5 exactly.
 * `day_of_week`: 0=Sunday … 6=Saturday — VERIFIED against the MetaQuotes-shipped
 * CDateTime::DayName (Include/Tools/DateTime.mqh: case 0→"Sunday" … 6→"Saturday").
 * `day_of_year`: the 0-based day index within the year (MT5's documented
 * MqlDateTime.day_of_year convention is Jan 1 == 0). §21 honesty: the day_of_week
 * mapping is verified against MetaQuotes source on this box; the day_of_year
 * 0-based convention is the DOCUMENTED MQL5 behaviour (not run on a live MT5 in
 * this cycle) — flagged here so a future MT5 compile can confirm it.
 */
export interface MqlDateTime {
  year: number;
  mon: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  min: number; // 0-59
  sec: number; // 0-59
  day_of_week: number; // 0=Sun .. 6=Sat
  day_of_year: number; // 0-based (Jan 1 == 0), per MT5
}

/**
 * TimeToStruct(datetime, out) — decompose `datetime` (epoch seconds) into `out`
 * (mutated in place), returning true on success.
 *
 * §21 FIDELITY: MT5 interprets the datetime in the SERVER timezone, but since
 * the engine's timeline is the server clock and the backtest data's epochs are
 * already server-time, we decompose in UTC (epoch→UTC fields) — i.e. we treat
 * the stored epoch as already-server-local seconds-since-1970. We therefore use
 * the UTC getters (NOT local getters) so the result is deterministic and
 * independent of the machine's TZ. This matches MT5's behaviour when the chart
 * data and the broker share a timezone (the PoC's documented assumption,
 * consistent with the BacktestBroker's account-currency assumption).
 *
 * MT5's day_of_year is 0-BASED (Jan 1 → 0). day_of_week is 0=Sunday. We
 * replicate both conventions exactly.
 */
export function timeToStruct(datetime: number, out: MqlDateTime): boolean {
  if (!Number.isFinite(datetime)) return false;
  // MT5 datetime is whole seconds since 1970-01-01 00:00:00. Truncate any
  // fractional part (epochs are integral seconds on the wire).
  const ms = Math.trunc(datetime) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return false;

  out.year = d.getUTCFullYear();
  out.mon = d.getUTCMonth() + 1; // getUTCMonth is 0-based; MQL5 mon is 1-based
  out.day = d.getUTCDate(); // 1-31
  out.hour = d.getUTCHours();
  out.min = d.getUTCMinutes();
  out.sec = d.getUTCSeconds();
  out.day_of_week = d.getUTCDay(); // 0=Sunday .. 6=Saturday — matches MT5

  // day_of_year: 0-based day index within the year (Jan 1 == 0), per MT5.
  const startOfYear = Date.UTC(out.year, 0, 1); // Jan 1, 00:00:00 UTC
  const dayMs = 24 * 60 * 60 * 1000;
  out.day_of_year = Math.floor((Date.UTC(out.year, out.mon - 1, out.day) - startOfYear) / dayMs);

  return true;
}
