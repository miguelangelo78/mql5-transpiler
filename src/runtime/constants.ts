/**
 * MQL5 compile-time constants (ENUM_* members and predefined #defines).
 *
 * These are merged into the `Runtime` (see runtime.ts: `Runtime = RuntimeApi &
 * MqlConst`) so the emitter references them as `rt.MODE_SMA` etc. Adding a
 * constant here requires NO change to the Runtime interface.
 *
 * FIDELITY STATUS (global CLAUDE.md §21 — replicate MT5 EXACTLY, no guesses):
 *
 * Two classes of constant live here:
 *   1. VALUES (INVALID_HANDLE, INIT_*, MODE_*, PRICE_*, POSITION_TYPE_*,
 *      TRADE_RETCODE_*) — known-correct, used directly in logic. Trustworthy.
 *   2. SELECTOR IDS (the integer ids passed to PositionGet... / AccountInfo... /
 *      SymbolInfo... ) — in THIS engine they are INTERNAL ONLY: PositionGetInteger
 *      etc. dispatch on these ids locally and the value never leaves the
 *      runtime (nothing is sent on a wire). So the PoC is correct for ANY
 *      self-consistent, collision-free assignment, which these are.
 *
 * ⚠️ HONESTY: the selector ids below are NOT yet ground-truth-verified against
 * a real MT5 compile. They are internal-only dispatch keys (PositionGet...,
 * AccountInfo... and SymbolInfo... switch on the NAMED constants, never on the
 * literal integers, and nothing goes on a wire), so the engine is correct for any
 * collision-free assignment. The "// unverified" tags below mark them honestly
 * until observed from a real MT5 compile. To ground-truth them, compile a tiny
 * MQL5 script that Prints `(int)POSITION_TYPE` etc. and read the values, then
 * set each id and flip its "// unverified" tag.
 *
 * These selector ids are INTERNAL-ONLY dispatch keys (PositionGet..., AccountInfo...
 * and SymbolInfo... switch on the NAMED constants, never on the literal integers,
 * and nothing is sent on a wire), so the engine is correct for any collision-free
 * assignment — but the labels stay honest until observed.
 */

export const MQL_CONST = {
  // ── handles / misc ──
  INVALID_HANDLE: -1,
  WHOLE_ARRAY: 0,
  NULL: 0,
  EMPTY_VALUE: Number.MAX_VALUE, // DBL_MAX in MT5
  clrNONE: -1,

  // ── ENUM_INIT_RETCODE ──
  INIT_SUCCEEDED: 0,
  INIT_FAILED: 1,
  INIT_PARAMETERS_INCORRECT: 2,
  INIT_AGENT_NOT_SUITABLE: 3,

  // ── ENUM_MA_METHOD ──
  MODE_SMA: 0,
  MODE_EMA: 1,
  MODE_SMMA: 2,
  MODE_LWMA: 3,

  // ── ENUM_APPLIED_PRICE ──
  PRICE_CLOSE: 1,
  PRICE_OPEN: 2,
  PRICE_HIGH: 3,
  PRICE_LOW: 4,
  PRICE_MEDIAN: 5,
  PRICE_TYPICAL: 6,
  PRICE_WEIGHTED: 7,

  // ── ENUM_POSITION_TYPE ──
  POSITION_TYPE_BUY: 0,
  POSITION_TYPE_SELL: 1,

  // ── ENUM_POSITION_PROPERTY_INTEGER (selectors) ──
  // UNVERIFIED selector ids (internal-only dispatch — see file header).
  // Self-consistent + collision-free; ground-truth verification backlogged.
  POSITION_TICKET: 17, // unverified (was 1)
  POSITION_TIME: 1, // unverified (was 2)
  POSITION_TYPE: 2, // unverified (was 12)
  POSITION_MAGIC: 12, // unverified (matches widely-cited value)
  POSITION_IDENTIFIER: 13, // unverified (matches widely-cited value)
  POSITION_REASON: 18, // unverified (was 14)

  // ── ENUM_POSITION_PROPERTY_DOUBLE (selectors) ──
  POSITION_VOLUME: 3, // unverified (was 8)
  POSITION_PRICE_OPEN: 4, // unverified (was 9)
  POSITION_PRICE_CURRENT: 5, // unverified (was 10)
  POSITION_SL: 6, // unverified (was 11)
  POSITION_TP: 7, // unverified (was 12)
  POSITION_PROFIT: 10, // unverified (was 17)
  POSITION_SWAP: 9, // unverified (was 16)

  // ── ENUM_POSITION_PROPERTY_STRING ──
  POSITION_SYMBOL: 0, // unverified (was 1)
  POSITION_COMMENT: 11, // unverified (was 2)

  // ── ENUM_ACCOUNT_INFO_DOUBLE (selectors) ──
  ACCOUNT_BALANCE: 37, // unverified (was 0)
  ACCOUNT_EQUITY: 40, // unverified (was 1)
  ACCOUNT_MARGIN: 41, // unverified (was 2)
  ACCOUNT_MARGIN_FREE: 42, // unverified (was 3)
  ACCOUNT_PROFIT: 39, // unverified (was 6)

  // ── ENUM_ACCOUNT_INFO_INTEGER ──
  ACCOUNT_LOGIN: 0, // unverified (matches widely-cited value)
  ACCOUNT_LEVERAGE: 35, // unverified (was 1)

  // ── ENUM_SYMBOL_INFO_DOUBLE (selectors) ──
  SYMBOL_BID: 1, // unverified (matches widely-cited value)
  SYMBOL_ASK: 4, // unverified (was 2)
  SYMBOL_POINT: 16, // unverified (was 4)
  SYMBOL_VOLUME_MIN: 34, // unverified (matches widely-cited value)
  SYMBOL_VOLUME_MAX: 35, // unverified (matches widely-cited value)
  SYMBOL_VOLUME_STEP: 36, // unverified (matches widely-cited value)
  SYMBOL_TRADE_TICK_VALUE: 26, // unverified (matches widely-cited value)
  SYMBOL_TRADE_TICK_SIZE: 27, // unverified (matches widely-cited value)
  SYMBOL_TRADE_CONTRACT_SIZE: 28, // unverified (matches widely-cited value)

  // ── ENUM_SYMBOL_INFO_INTEGER ──
  SYMBOL_DIGITS: 17, // unverified (matches widely-cited value)

  // ── ENUM_TIMEFRAMES (UNVERIFIED selector ids — see file header) ──
  PERIOD_CURRENT: 0,
  PERIOD_M1: 1, // unverified
  PERIOD_M5: 5, // unverified
  PERIOD_M15: 15, // unverified
  PERIOD_M30: 30, // unverified
  PERIOD_H1: 16385, // unverified — likely correct (0x4001)
  PERIOD_H4: 16388, // unverified — likely correct (0x4004)
  PERIOD_D1: 16408, // unverified — likely correct (0x4018)
  PERIOD_W1: 32769, // unverified — likely correct (0x8001)
  PERIOD_MN1: 49153, // unverified — likely correct (0xC001)

  // ── ENUM_ORDER_TYPE (known-correct documented values, used in logic) ──
  ORDER_TYPE_BUY: 0,
  ORDER_TYPE_SELL: 1,
  ORDER_TYPE_BUY_LIMIT: 2,
  ORDER_TYPE_SELL_LIMIT: 3,
  ORDER_TYPE_BUY_STOP: 4,
  ORDER_TYPE_SELL_STOP: 5,
  ORDER_TYPE_BUY_STOP_LIMIT: 6,
  ORDER_TYPE_SELL_STOP_LIMIT: 7,
  ORDER_TYPE_CLOSE_BY: 8,

  // ── ENUM_ORDER_TYPE_TIME (subset, known-correct) ──
  ORDER_TIME_GTC: 0,
  ORDER_TIME_DAY: 1,
  ORDER_TIME_SPECIFIED: 2,
  ORDER_TIME_SPECIFIED_DAY: 3,

  // ── TRADE_RETCODE (subset) ──
  TRADE_RETCODE_DONE: 10009,
  TRADE_RETCODE_REQUOTE: 10004,
  TRADE_RETCODE_REJECT: 10006,

  // ── ENUM_SERIESMODE (iHighest/iLowest `type`) — CANONICAL MQL5 values ──
  // These ARE the documented MQL5 ids (MODE_OPEN=0 … MODE_REAL_VOLUME=5) and
  // are passed straight into the series scanner, which switches on them. They
  // mirror ./indicators/series.ts SERIES_MODE exactly — keep both in sync.
  MODE_OPEN: 0,
  MODE_LOW: 1,
  MODE_HIGH: 2,
  MODE_CLOSE: 3,
  MODE_VOLUME: 4, // tick volume
  MODE_REAL_VOLUME: 5,

  // ── TIME_* flags (TimeToString) — CANONICAL MQL5 values (1/2/4) ──
  // Documented MQL5 constants; passed into ./host/convert.ts TimeToString,
  // which masks on them. Mirror ./host/convert.ts TIME_* — keep in sync.
  TIME_DATE: 1,
  TIME_MINUTES: 2,
  TIME_SECONDS: 4,

  // ── ENUM_ORDER_PROPERTY_* selector ids ──
  // INTERNAL-ONLY dispatch keys (see file header §2): OrderGetInteger/Double/
  // String switch on these locally; nothing is sent on a wire, so any
  // self-consistent collision-free assignment is correct. These MUST equal the
  // ./orders.ts `OrderProp` enum values (the helper's switch keys).
  // integers
  ORDER_TICKET: 1,
  ORDER_TIME_SETUP: 2,
  ORDER_TYPE: 3,
  ORDER_MAGIC: 4,
  ORDER_STATE: 5,
  ORDER_TYPE_TIME: 6,
  ORDER_POSITION_ID: 7,
  // doubles
  ORDER_VOLUME_INITIAL: 20,
  ORDER_VOLUME_CURRENT: 21,
  ORDER_PRICE_OPEN: 22,
  ORDER_SL: 23,
  ORDER_TP: 24,
  ORDER_PRICE_STOPLIMIT: 25,
  ORDER_PRICE_CURRENT: 26,
  // strings
  ORDER_SYMBOL: 40,
  ORDER_COMMENT: 41,

  // ── ENUM_ORDER_STATE (subset, used in logic) ──
  ORDER_STATE_PLACED: 1, // unverified label; a resting pending is PLACED

  // ── ENUM_DEAL_PROPERTY_* selector ids ──
  // INTERNAL-ONLY dispatch (see file header §2). MUST equal ./history.ts
  // `DealProp` enum values.
  // integers
  DEAL_TICKET: 1,
  DEAL_ORDER: 2,
  DEAL_TIME: 3,
  DEAL_TYPE: 4,
  DEAL_ENTRY: 5,
  // doubles
  DEAL_VOLUME: 20,
  DEAL_PRICE: 21,
  DEAL_PROFIT: 22,
  DEAL_COMMISSION: 23,
  DEAL_SWAP: 24,
  // strings
  DEAL_SYMBOL: 40,
  DEAL_COMMENT: 41,

  // ── ENUM_DEAL_TYPE / ENUM_DEAL_ENTRY (used in logic; canonical MQL5 small ids) ──
  DEAL_TYPE_BUY: 0,
  DEAL_TYPE_SELL: 1,
  DEAL_ENTRY_IN: 0, // open leg
  DEAL_ENTRY_OUT: 1, // close leg

  // ── ENUM_SYMBOL_INFO_STRING selector ids ──
  // INTERNAL-ONLY dispatch (see file header §2). MUST equal ./reads.ts
  // `SymbolStringProp` enum values.
  SYMBOL_NAME: 1, // not a real MQL5 selector; convenience id (see reads.ts)
  SYMBOL_DESCRIPTION: 2,
  SYMBOL_CURRENCY_BASE: 3,
  SYMBOL_CURRENCY_PROFIT: 4,
  SYMBOL_CURRENCY_MARGIN: 5,

  // ── ENUM_ACCOUNT_INFO_STRING selector ids ──
  // INTERNAL-ONLY dispatch (see file header §2). MUST equal ./reads.ts
  // `AccountStringProp` enum values.
  ACCOUNT_NAME: 1,
  ACCOUNT_SERVER: 2,
  ACCOUNT_CURRENCY: 3,
  ACCOUNT_COMPANY: 4,
} as const;

export type MqlConst = typeof MQL_CONST;
