/**
 * CAccountInfo — the MT5 Standard-Library account-info wrapper (subset).
 *
 * MetaQuotes' `CAccountInfo` (Include/Trade/AccountInfo.mqh) wraps the
 * AccountInfo* builtins:
 *
 *   Login()    → AccountInfoInteger(ACCOUNT_LOGIN)
 *   Leverage() → AccountInfoInteger(ACCOUNT_LEVERAGE)
 *   Balance()/Equity()/Margin()/FreeMargin()/Profit()
 *              → AccountInfoDouble(ACCOUNT_BALANCE/EQUITY/MARGIN/MARGIN_FREE/PROFIT)
 *   Currency() → AccountInfoString(ACCOUNT_CURRENCY)
 *
 * §21 fidelity: every accessor delegates to the runtime builtin that already
 * replicates MT5 over the provider boundary — so the wrapper inherits its
 * exactness (and its honest limitations) verbatim and adds only the OO sugar.
 *
 * Construction (emission ABI): `new rt.CAccountInfo(rt)`.
 */

import type { Runtime } from '../runtime';

export class CAccountInfo {
  constructor(private readonly rt: Runtime) {}

  /** ACCOUNT_LOGIN (the trading account number). */
  Login(): number {
    return this.rt.AccountInfoInteger(this.rt.ACCOUNT_LOGIN);
  }
  /** ACCOUNT_LEVERAGE (e.g. 100 for 1:100). */
  Leverage(): number {
    return this.rt.AccountInfoInteger(this.rt.ACCOUNT_LEVERAGE);
  }

  /** ACCOUNT_BALANCE (closed-trade balance; §29: 0 is a valid balance). */
  Balance(): number {
    return this.rt.AccountInfoDouble(this.rt.ACCOUNT_BALANCE);
  }
  /** ACCOUNT_EQUITY (balance + floating P/L). */
  Equity(): number {
    return this.rt.AccountInfoDouble(this.rt.ACCOUNT_EQUITY);
  }
  /** ACCOUNT_MARGIN (margin currently used). */
  Margin(): number {
    return this.rt.AccountInfoDouble(this.rt.ACCOUNT_MARGIN);
  }
  /** ACCOUNT_MARGIN_FREE (free margin available for new positions). */
  FreeMargin(): number {
    return this.rt.AccountInfoDouble(this.rt.ACCOUNT_MARGIN_FREE);
  }
  /** ACCOUNT_PROFIT (current floating P/L across all positions). */
  Profit(): number {
    return this.rt.AccountInfoDouble(this.rt.ACCOUNT_PROFIT);
  }

  /** ACCOUNT_CURRENCY (the deposit currency code, e.g. "USD"). */
  Currency(): string {
    return this.rt.AccountInfoString(this.rt.ACCOUNT_CURRENCY);
  }
}
