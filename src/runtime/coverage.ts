/**
 * Runtime coverage — the landmine detector.
 *
 * The intrinsic table (../sema/intrinsics.ts) recognises far MORE MQL5 builtins
 * than the runtime (./index.ts + ./ctrade.ts) actually IMPLEMENTS. A builtin
 * that is recognised-but-unimplemented transpiles cleanly, then throws an opaque
 * error the first time it executes (e.g. `iRSI`/`iATR` are throwing stubs;
 * `BuyLimit`/`OrderModify` aren't on CTrade at all). This module closes that
 * gap at COMPILE time: it enumerates what `createRuntime` truly provides and
 * cross-references a module's `usedBuiltins` against it, emitting an
 * `MQL_UNIMPLEMENTED_BUILTIN` diagnostic for every recognised-but-unimplemented
 * builtin the program uses.
 *
 * Honesty discipline (§21): `RUNTIME_COVERAGE` lists ONLY methods that are real
 * implementations — NOT throwing stubs. `iRSI`/`iATR` are now REAL (they compute
 * Wilder RSI / MT5 SMA-of-True-Range via the indicator registry — verified
 * non-stub in index.ts → IndicatorRegistry.iRSI/iATR), so they are LISTED.
 * `AccountInfoString` (which still `throw`s) remains deliberately EXCLUDED, so a
 * program using it is flagged rather than silently shipped. This set is derived
 * by reading the runtime source by hand; it is the contract "what does the
 * runtime really do", and MUST be kept in sync when the runtime grows (adding a
 * real implementation = add its name here; the test suite pins the sample EAs'
 * full coverage so a regression here is caught).
 *
 * This module MAY import the runtime intrinsics (it lives under runtime/ and
 * cross-references runtime capability). The frontend (lower.ts) must NOT import
 * it — keeping lowering pure of runtime knowledge.
 */

import type { IRModule } from '../ir/nodes';
import type { Diagnostic } from '../diagnostics';
import {
  lookupFreeIntrinsic,
  lookupCTradeMethod,
  isContextVar,
  isRuntimeStruct,
} from '../sema/intrinsics';

/**
 * Free-function builtins that `RuntimeImpl` (./index.ts) implements for real —
 * i.e. they do the work, not `throw`.
 *
 * NOW IMPLEMENTED THIS CYCLE (real, moved OUT of the excluded set — each wired
 * in index.ts to a §21 MT5-source-faithful helper / registry entry point):
 *   - iMACD, iBands, iStochastic, iADX, iCCI, iMomentum  → IndicatorRegistry
 *     (handle ctor + CopyBuffer reads the computed buffer in SetIndexBuffer order)
 *   - iBars, iVolume, iHighest, iLowest                  → ./indicators/series
 *   - CopyTickVolume, CopyRealVolume, CopySpread, CopyRates → ./reads (as-series)
 *   - ArrayCopy, ArrayMaximum, ArrayMinimum, ArraySort   → ./host/array (the
 *     extrema thread the array's tracked as-series flag in, per MT5)
 *   - PositionGetTicket                                  → ./orders (select-by-index)
 *   - OrdersTotal, OrderSelect, OrderGetInteger/Double/String, OrderGetTicket
 *                                                        → ./orders OrderState
 *   - HistorySelect, HistoryDealsTotal, HistoryDealGet*  → ./history HistoryState
 *   - AccountInfoString                                  → ./reads (honest-partial:
 *     answers ACCOUNT_CURRENCY; other string props throw — no fabricated name)
 *   - SymbolInfoString, SymbolSelect                     → ./reads (honest-partial)
 *   - TimeTradeServer, TimeGMT, TimeToStruct             → ./reads
 *   - Math* (Abs/Max/Min/Floor/Ceil/Round/Sqrt/Pow/Log/Exp/Sin/Cos/Tan/Mod/Rand)
 *                                                        → ./host/math
 *   - String* (Format/Len/Substr/Find/Replace/ToDouble/ToInteger) + DoubleToString
 *     / IntegerToString / TimeToString / PrintFormat     → ./host/str + ./host/convert
 *
 * Previously made real: iRSI, iATR (Wilder RSI / MT5 SMA-of-True-Range);
 * EventSetTimer/EventSetMillisecondTimer/EventKillTimer (engine-driven cadence).
 *
 * NOW IMPLEMENTED this cycle (moved OUT of the excluded set):
 *   - iCustom     → SOURCE custom-indicator transpilation (CustomIndicatorRegistry;
 *                   compiles <name>.mq5 with the same frontend+backend, runs its
 *                   OnCalculate, CopyBuffer reads its buffers with as-series /
 *                   warm-up semantics identical to a native handle).
 *   - OrderSend   → the raw trade primitive over IBroker (mutates the result
 *                   struct in place; §21 honest reject on an unserviceable action).
 *
 * EXCLUDED on purpose (recognised in the intrinsic table but NOT implemented),
 * so a program using one is flagged rather than silently shipped:
 *   - OrderCheck / OrderCalcMargin / OrderCalcProfit
 *                 → need a margin/profit projection the provider boundary does
 *                   not expose (no per-symbol margin-rate on IBroker); faking a
 *                   projection would violate §21. The honest remainder.
 *
 * NOTE on "honest-partial" methods (AccountInfoString, SymbolInfoString,
 * OrderGetDouble(ORDER_PRICE_CURRENT)): the method IS a real implementation and
 * does the work for every property the provider boundary carries; it THROWS only
 * on a property the boundary genuinely cannot supply — exactly the existing
 * AccountInfoDouble / SymbolInfoDouble / PositionGetDouble pattern (which are
 * listed as covered). The method is present and non-stub, so it is covered; the
 * per-property throw is the §21-honest "not carried" signal, not a stub.
 *
 * Each name below is verified present (non-stub) on `RuntimeApi` / `RuntimeImpl`.
 */
const RUNTIME_FREE_BUILTINS: ReadonlySet<string> = new Set<string>([
  // indicators (real)
  'iMA',
  'iRSI',
  'iATR',
  'iMACD',
  'iBands',
  'iStochastic',
  'iADX',
  'iCCI',
  'iMomentum',
  'iCustom',
  'CopyBuffer',
  'IndicatorRelease',
  // timer / events (real — engine-driven OnTimer cadence)
  'EventSetTimer',
  'EventSetMillisecondTimer',
  'EventKillTimer',
  // timeseries (real)
  'Bars',
  'iBars',
  'CopyClose',
  'CopyOpen',
  'CopyHigh',
  'CopyLow',
  'CopyTime',
  'CopyTickVolume',
  'CopyRealVolume',
  'CopySpread',
  'CopyRates',
  'iClose',
  'iOpen',
  'iHigh',
  'iLow',
  'iTime',
  'iVolume',
  'iHighest',
  'iLowest',
  // arrays (real)
  'ArraySetAsSeries',
  'ArrayGetAsSeries',
  'ArrayResize',
  'ArraySize',
  'ArrayFill',
  'ArrayInitialize',
  'ArrayCopy',
  'ArrayMaximum',
  'ArrayMinimum',
  'ArraySort',
  // positions (real)
  'PositionSelect',
  'PositionSelectByTicket',
  'PositionsTotal',
  'PositionGetSymbol',
  'PositionGetTicket',
  'PositionGetInteger',
  'PositionGetDouble',
  'PositionGetString',
  // pending orders (real — OrderState over the broker pending pool)
  'OrdersTotal',
  'OrderSelect',
  'OrderGetTicket',
  'OrderGetInteger',
  'OrderGetDouble',
  'OrderGetString',
  // history (real — HistoryState selected-window over the broker deal log)
  'HistorySelect',
  'HistoryDealsTotal',
  'HistoryDealGetTicket',
  'HistoryDealGetInteger',
  'HistoryDealGetDouble',
  'HistoryDealGetString',
  // account (real — AccountInfoString is now a real honest-partial impl)
  'AccountInfoDouble',
  'AccountInfoInteger',
  'AccountInfoString',
  // symbol (real)
  'SymbolInfoDouble',
  'SymbolInfoInteger',
  'SymbolInfoString',
  'SymbolInfoTick',
  'SymbolSelect',
  // raw trade API (real — OrderSend over the IBroker boundary; mutates the
  // result struct in place, §21 honest reject on an egress that can't service
  // an action). OrderCheck/OrderCalcMargin/OrderCalcProfit stay EXCLUDED below.
  'OrderSend',
  // time (real)
  'TimeCurrent',
  'TimeLocal',
  'TimeTradeServer',
  'TimeGMT',
  'TimeToStruct',
  // math host helpers (real — pure, MT5-exact)
  'MathAbs',
  'MathMax',
  'MathMin',
  'MathFloor',
  'MathCeil',
  'MathRound',
  'MathSqrt',
  'MathPow',
  'MathLog',
  'MathExp',
  'MathSin',
  'MathCos',
  'MathTan',
  'MathMod',
  'MathRand',
  // string + conversion host helpers (real — pure, MT5-exact)
  'StringFormat',
  'StringLen',
  'StringSubstr',
  'StringFind',
  'StringReplace',
  'StringToDouble',
  'StringToInteger',
  'DoubleToString',
  'IntegerToString',
  'TimeToString',
  'PrintFormat',
  // host helpers (real)
  'NormalizeDouble',
  'Print',
  'Comment',
  'Alert',
  'GetLastError',
  'ResetLastError',
]);

/**
 * CTrade methods that `CTrade` (./ctrade.ts) implements for real.
 *
 * NOW IMPLEMENTED this cycle (real, listed below — moved OUT of the excluded set,
 * each verified non-stub in ctrade.ts):
 *   PositionOpen        → routes ORDER_TYPE_BUY/SELL to placeMarketOrder
 *                         (§21 honest reject on a non-market order type)
 *   OrderModify         → modifies a resting pending via broker.modifyPendingOrder
 *                         (§21 honest guard on an egress lacking it)
 *   SetTypeFillingBySymbol / SetMarginMode / SetAsyncMode
 *                       → config setters (stored; documented no-op on the
 *                         deterministic backtest engine — accepted, never faked)
 *   ResultBid / ResultAsk → return 0 (the boundary's TradeResult carries no
 *                         requote bid/ask; honest "not carried", not fabricated)
 *   ResultComment / CheckResultRetcode / RequestMagic → real last-result reads
 *
 * Previously made real: BuyLimit/SellLimit/BuyStop/SellStop/OrderDelete (route
 * to the optional IBroker pending methods, §21 honest guard — retcode 10013 —
 * on an egress lacking pending support; the backtest provider implements them).
 *
 * EXCLUDED (recognised in CTRADE_METHODS but NOT implemented on the class), so a
 * program using one is flagged rather than silently shipped:
 *   - OrderOpen → the pending-OPEN variant (vs PositionOpen, the market-open).
 *     Fold in alongside BuyLimit/etc. when needed. The honest remainder here.
 *
 * NOTE on the config setters + ResultBid/ResultAsk: these ARE real
 * implementations (present, non-stub) that honestly do what the boundary
 * permits — the setters store + accept (documented no-op on backtest fills),
 * ResultBid/ResultAsk return the §21 "not carried" 0. That is the same
 * honest-partial pattern as AccountInfoString below; the method is present, so
 * it is covered.
 */
const RUNTIME_CTRADE_METHODS: ReadonlySet<string> = new Set<string>([
  // trading (real)
  'Buy',
  'Sell',
  'PositionClose',
  'PositionModify',
  'PositionOpen',
  // pending orders (real — rest in the backtest book; §21 honest guard on
  // egresses that lack the optional IBroker pending methods)
  'BuyLimit',
  'SellLimit',
  'BuyStop',
  'SellStop',
  'OrderDelete',
  'OrderModify',
  // configuration (real)
  'SetExpertMagicNumber',
  'SetDeviationInPoints',
  'SetTypeFilling',
  'SetTypeFillingBySymbol',
  'SetMarginMode',
  'SetAsyncMode',
  'LogLevel',
  // last-result accessors (real)
  'ResultRetcode',
  'ResultRetcodeDescription',
  'ResultDeal',
  'ResultOrder',
  'ResultVolume',
  'ResultPrice',
  'ResultBid',
  'ResultAsk',
  'ResultComment',
  'CheckResultRetcode',
  'RequestMagic',
]);

/**
 * Predefined context variables the runtime provides for real (getters on `rt`).
 *
 * EXCLUDED (recognised in CONTEXT_VARS but NOT on RuntimeApi): _RandomSeed,
 * _StopFlag, _UninitReason. (_LastError IS implemented as a field.)
 */
const RUNTIME_CONTEXT_VARS: ReadonlySet<string> = new Set<string>([
  '_Symbol',
  '_Period',
  '_Digits',
  '_Point',
  '_LastError',
]);

/**
 * Builtin runtime STRUCT classes (`new rt.MqlTradeRequest()` etc.) the runtime
 * provides for real (assigned as the classes on RuntimeImpl, see ./index.ts).
 * A used struct name in `usedBuiltins` lowered as a runtime construction; if the
 * runtime didn't ship the class it would throw at run time, so an unshipped
 * struct must be flagged. All four ARE shipped this cycle (mqlStructs.ts).
 */
const RUNTIME_STRUCTS_PROVIDED: ReadonlySet<string> = new Set<string>([
  'MqlTradeRequest',
  'MqlTradeResult',
  'MqlTradeCheckResult',
  'MqlTradeTransaction',
]);

/**
 * The honest capability surface of `createRuntime`. Exported so tooling/tests
 * can introspect exactly what the runtime implements (not what the intrinsic
 * table merely recognises).
 */
export const RUNTIME_COVERAGE: {
  freeBuiltins: ReadonlySet<string>;
  ctradeMethods: ReadonlySet<string>;
  contextVars: ReadonlySet<string>;
} = {
  freeBuiltins: RUNTIME_FREE_BUILTINS,
  ctradeMethods: RUNTIME_CTRADE_METHODS,
  contextVars: RUNTIME_CONTEXT_VARS,
};

/**
 * Host pseudo-intrinsics the lowering emits into `usedBuiltins` that are NOT
 * driven by the public intrinsic table — they have bespoke emission/runtime
 * handling and are never "unimplemented builtin" findings. (`__delete` lowers
 * MQL5 `delete p`; `sizeof` is a parser pseudo-call.)
 */
const PSEUDO_INTRINSICS: ReadonlySet<string> = new Set<string>(['__delete', 'sizeof']);

/**
 * Cross-reference a module's used builtins against the runtime's real coverage.
 * Returns one `MQL_UNIMPLEMENTED_BUILTIN` error diagnostic per distinct
 * recognised-but-unimplemented builtin (free function, CTrade method, or
 * context variable) the program references.
 *
 * It ONLY flags names the intrinsic table actually RECOGNISES — an unrecognised
 * free call is a separate concern (MQL_UNKNOWN_CALL, raised by lowering), and a
 * builtin CONSTANT in `usedBuiltins` is data merged onto `rt` (always present),
 * not a callable, so constants are never flagged here.
 */
export function checkCoverage(mod: IRModule): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const used of mod.usedBuiltins) {
    // CTrade methods are recorded as "CTrade.<method>".
    if (used.startsWith('CTrade.')) {
      const method = used.slice('CTrade.'.length);
      // Only flag a method the intrinsic table recognises (so it lowered as an
      // intrinsic CTrade call) but the class doesn't implement.
      if (lookupCTradeMethod(method) && !RUNTIME_CTRADE_METHODS.has(method)) {
        diagnostics.push({
          severity: 'error',
          code: 'MQL_UNIMPLEMENTED_BUILTIN',
          message:
            `CTrade.${method}() is recognised but NOT implemented in the runtime ` +
            `(it would throw at run time). Implement it on the CTrade class, or ` +
            `avoid it in the EA.`,
          symbol: `CTrade.${method}`,
        });
      }
      continue;
    }

    // Pseudo-intrinsics: never a coverage finding.
    if (PSEUDO_INTRINSICS.has(used)) continue;

    // Builtin runtime STRUCT (MqlTradeRequest etc.)? It lowered as a runtime
    // construction `new rt.<Name>()`; flag it only if the runtime didn't ship
    // the class (it would throw at run time). All four ARE shipped this cycle,
    // so this never fires today — it guards a future struct added to the
    // intrinsic table before its class lands on the runtime.
    if (isRuntimeStruct(used)) {
      if (!RUNTIME_STRUCTS_PROVIDED.has(used)) {
        diagnostics.push({
          severity: 'error',
          code: 'MQL_UNIMPLEMENTED_BUILTIN',
          message:
            `Builtin struct '${used}' is recognised but NOT provided by the ` +
            `runtime (\`new rt.${used}()\` would throw at run time). Implement ` +
            `it on the Runtime, or avoid it in the EA.`,
          symbol: used,
        });
      }
      continue;
    }

    // Context variable?
    if (isContextVar(used)) {
      if (!RUNTIME_CONTEXT_VARS.has(used)) {
        diagnostics.push({
          severity: 'error',
          code: 'MQL_UNIMPLEMENTED_BUILTIN',
          message:
            `Context variable '${used}' is recognised but NOT provided by the ` +
            `runtime (it would be undefined at run time). Implement it on the ` +
            `Runtime, or avoid it in the EA.`,
          symbol: used,
        });
      }
      continue;
    }

    // Free-function intrinsic? Flag only those the intrinsic table recognises
    // (so they lowered to `rt.<name>(...)`) but the runtime doesn't implement.
    if (lookupFreeIntrinsic(used) && !RUNTIME_FREE_BUILTINS.has(used)) {
      diagnostics.push({
        severity: 'error',
        code: 'MQL_UNIMPLEMENTED_BUILTIN',
        message:
          `Builtin '${used}()' is recognised but NOT implemented in the runtime ` +
          `(it is a stub or absent — it would throw at run time). Implement it on ` +
          `the Runtime, or avoid it in the EA.`,
        symbol: used,
      });
    }
    // Anything else in usedBuiltins (builtin CONSTANTS like MODE_SMA,
    // INVALID_HANDLE) is data merged onto `rt` and always present — not flagged.
  }

  return diagnostics;
}
