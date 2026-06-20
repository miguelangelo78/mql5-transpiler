/**
 * CSymbolInfo — the MT5 Standard-Library symbol-info wrapper (subset).
 *
 * MetaQuotes' `CSymbolInfo` (Include/Trade/SymbolInfo.mqh) wraps a symbol name +
 * the SymbolInfo + tick builtins:
 *
 *   Name(symbol)/Name()    → set/get the bound symbol (m_name)
 *   Refresh()/RefreshRates() → re-read the symbol's spec / current tick. Our
 *                            runtime reads are already live (no cached snapshot),
 *                            so both succeed and return true — there is nothing
 *                            to stale-refresh. (Documented; observationally
 *                            identical to MT5 for read-then-use.)
 *   Bid()/Ask()            → the current tick bid/ask (feed.tick via SymbolInfoTick)
 *   Point()/Digits()       → SYMBOL_POINT / SYMBOL_DIGITS
 *   Spread()               → current spread in POINTS, computed from the live
 *                            (ask - bid) / point (MT5's SYMBOL_SPREAD is exactly
 *                            this quantity; the provider boundary carries no
 *                            separate spread field, so we compute it from the
 *                            same inputs MT5 derives it from — NOT a fabrication)
 *   VolumeMin()/VolumeMax()/VolumeStep()/TickValue()
 *                          → SymbolInfoDouble(SYMBOL_VOLUME_* / SYMBOL_TRADE_TICK_VALUE)
 *
 * §21 fidelity: every accessor delegates to a runtime builtin that already
 * replicates MT5 over the provider boundary. The bound symbol defaults to the
 * chart symbol (`_Symbol`), matching CSymbolInfo's typical post-`Name(_Symbol)`
 * usage.
 *
 * Construction (emission ABI): `new rt.CSymbolInfo(rt)`.
 */

import type { Runtime } from '../runtime';

export class CSymbolInfo {
  private name: string;

  constructor(private readonly rt: Runtime) {
    // Default to the chart symbol; the EA usually calls Name(_Symbol) anyway.
    this.name = rt._Symbol;
  }

  /** Bind the symbol this info object reports on. (MT5 returns bool ok.) */
  Name(symbol: string): boolean;
  /** Get the bound symbol name. */
  Name(): string;
  Name(symbol?: string): boolean | string {
    if (symbol === undefined) return this.name;
    this.name = symbol;
    // MT5 returns true when the symbol is valid/selectable; SymbolSelect probes
    // availability honestly (false for an unknown symbol).
    return this.rt.SymbolSelect(symbol, true);
  }

  /**
   * Refresh()/RefreshRates() — MT5 re-reads the cached spec/tick. Our runtime
   * reads are live every call (no cached snapshot to refresh), so these are
   * accepted and succeed. Returning true is the honest answer: the data IS
   * current. (§21 — documented no-op, not a faked refresh.)
   */
  Refresh(): boolean {
    return true;
  }
  RefreshRates(): boolean {
    return true;
  }

  // ── price reads (live tick) ──

  /** Current bid. */
  Bid(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_BID);
  }
  /** Current ask. */
  Ask(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_ASK);
  }

  // ── spec reads ──

  /** SYMBOL_POINT (the price increment for one point). */
  Point(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_POINT);
  }
  /** SYMBOL_DIGITS (price decimal places). */
  Digits(): number {
    return this.rt.SymbolInfoInteger(this.name, this.rt.SYMBOL_DIGITS);
  }
  /**
   * Spread() — the current spread in POINTS. MT5's SYMBOL_SPREAD is the number
   * of points between ask and bid; we derive it from the same live inputs:
   * round((ask - bid) / point). The round guards floating-point so an exact
   * N-point spread reports as the integer N. (§29: a 0-point spread is a valid
   * answer — a perfectly tight market — not a sentinel.)
   */
  Spread(): number {
    const point = this.Point();
    if (!(point > 0)) return 0; // no point scale ⇒ no meaningful point-spread
    const spread = (this.Ask() - this.Bid()) / point;
    return Math.round(spread);
  }

  /** SYMBOL_VOLUME_MIN (minimum lot size). */
  VolumeMin(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_VOLUME_MIN);
  }
  /** SYMBOL_VOLUME_MAX (maximum lot size). */
  VolumeMax(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_VOLUME_MAX);
  }
  /** SYMBOL_VOLUME_STEP (lot-size increment). */
  VolumeStep(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_VOLUME_STEP);
  }
  /** SYMBOL_TRADE_TICK_VALUE (account-currency value of one tick per lot). */
  TickValue(): number {
    return this.rt.SymbolInfoDouble(this.name, this.rt.SYMBOL_TRADE_TICK_VALUE);
  }
}
