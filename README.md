# mql5-transpiler

Transpile **MQL5** (MetaTrader 5's language) into **TypeScript** and run the strategy on a
pluggable engine — **backtest** it on historical/synthetic data, or run it **live** against a
broker. Same transpiled EA; you just swap the provider.

> **Status: proof-of-concept, working end-to-end.** Two real EAs transpile and backtest
> deterministically. Bar-based fidelity tier (see [Fidelity & limitations](#fidelity--limitations-honest)).
> The transpiler is **honest about what it supports** — it tells you, per-EA, exactly what it can't run yet.

## Quickstart

Requires Node ≥ 20 (developed on Node 24).

```bash
npm install
npm run poc       # transpile + backtest the SMA-crossover sample
npm run poc:rsi   # transpile + backtest the RSI / ATR / pending-orders sample
```

## Run your own EA

Drop a `.mq5` anywhere and point the `ea` runner at it:

```bash
npm run ea -- path/to/YourEA.mq5
```

It **transpiles** your EA to TypeScript, tells you **exactly** what (if anything) it can't
support yet, and — if it's fully supported — **backtests** it on deterministic synthetic data
and prints a trade-for-trade report.

If your EA uses a builtin the runtime doesn't implement yet, you get a precise list and a
non-zero exit — never a silent breakage:

```
✗ YourEA uses 1 builtin(s) the runtime does not implement yet.
  error[MQL_UNIMPLEMENTED_BUILTIN]: Builtin 'iCustom()' is recognised but NOT implemented …
```

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--symbol <NAME>` | `EURUSD` | symbol name |
| `--timeframe <TF>` | `M1` | MT5 timeframe — name (`M1`/`M5`/`M15`/`M30`/`H1`/`H4`/`D1`/`W1`/`MN1`) or numeric id |
| `--bars <N>` | `3000` | number of **synthetic** bars (ignored with `--csv`) |
| `--seed <N>` | `0x5eed` | PRNG seed (deterministic — same seed, same bars) |
| `--price <N>` | `1.10` | starting price (synthetic only) |
| `--balance <N>` | `10000` | starting balance |
| `--input <Name=Value>` | — | set an EA input (repeatable); value parsed as number / `true` / `false` / string |

```bash
npm run ea -- examples/MovingAverageCross.mq5 --input InpFastPeriod=5 --input InpSlowPeriod=50
npm run ea -- examples/RsiReversal.mq5 --timeframe 15 --bars 2000 --seed 42
```

### Backtest on **real** broker history (`--source tickerall`)

`npm run ea` backtests on a synthetic feed by default. Add `--source tickerall`
and it fetches the symbol's **real historical candles from the broker** (through
the same TickerAll feed the live path streams, with the broker's own symbol spec)
and replays them deterministically. The transpiled EA is unchanged — only the data
source is: synthetic → real-history backtest → live, same EA throughout. This
mirrors MT5's Strategy Tester, which replays the history the terminal downloaded
from the broker.

Secrets come from the environment, never argv:

| | |
|---|---|
| `TICKERALL_API_KEY` | your TickerAll key (free demo tier works) |
| `BROKER_PASSWORD` | the broker account password |

| Flag | Default | Meaning |
|---|---|---|
| `--source tickerall` | `synthetic` | fetch real broker history instead of generating bars |
| `--broker <mt4\|mt5>` | `mt5` | broker platform |
| `--server <NAME>` | — | broker server, e.g. `FBS-Demo` (required) |
| `--account <N>` | — | numeric broker login (required) |
| `--symbol <NAME>` | — | broker-native symbol, e.g. `BTCUSD` (required) |
| `--history <N>` | `500` | bars of history to fetch |

```bash
TICKERALL_API_KEY=cf_api_… BROKER_PASSWORD=… \
  npm run ea -- examples/MovingAverageCross.mq5 \
    --source tickerall --server FBS-Demo --account 123456 \
    --symbol BTCUSD --timeframe D1 --history 500 \
    --input InpFastPeriod=20 --input InpSlowPeriod=50 --input InpLots=0.01
```

## What's supported

Coverage is honest: `npm run ea` reports any gap for **your** EA. Globally today:

- **Program type:** Expert Advisors. (Custom indicators / scripts / services / libraries are the next scope dial.)
- **Language:** preprocessor (`#include` / `#define` / `#property`), the full C/MQL5 expression
  grammar (precedence, ternary, casts, `new`/`delete`, member/index/call, pre/post `++`/`--`),
  all statement forms, `enum`/`struct`, `input` parameters, the `CTrade` Standard-Library class,
  object pointers.
- **Indicators — MT5-exact, replicated 1:1 from MetaQuotes' own source:** `iMA`
  (SMA / EMA / SMMA / LWMA), `iRSI` (Wilder), `iATR` (MT5's SMA-of-True-Range), `iBands`,
  `iMACD`, `iStochastic`, `iADX`, `iCCI`, `iMomentum`, plus `iBars` / `iHighest` / `iLowest` /
  `iVolume`. `CopyBuffer` (multi-buffer) with MT5 as-series indexing and per-method warm-up.
- **Trading:** `CTrade.Buy` / `Sell` / `PositionClose` / `PositionModify`; **pending orders**
  `BuyLimit` / `SellLimit` / `BuyStop` / `SellStop` + `OrderDelete`; `PositionSelect` /
  `PositionGet*`; the order pool (`OrdersTotal` / `OrderSelect` / `OrderGet*`) and trade
  **history** (`HistorySelect` / `HistoryDealsTotal` / `HistoryDealGet*`).
- **Library functions:** `CopyRates` / `CopyClose` / … family, all `Math*`, `String*`
  (printf-faithful `StringFormat`), `Array*`, `*ToString`, `SymbolInfo*` / `AccountInfo*` /
  `Time*`. (~103 builtins covered.)
- **Events:** `OnInit` / `OnDeinit` / `OnTick` / `OnTimer` (+ `EventSetTimer` / `EventKillTimer`).
- **Not yet implemented** (caught at *compile* time, never silently): `iCustom`, raw
  `OrderSend`, a few `CTrade` methods (`PositionOpen` / `OrderModify` / config setters), and
  user classes-with-methods / templates. `npm run ea` names any gap in *your* EA; the exact
  implemented set lives in [`src/runtime/coverage.ts`](src/runtime/coverage.ts).

## Examples

The [`examples/`](examples) directory has runnable EAs — **every one transpiles with zero
diagnostics and backtests.** Start with `npm run ea -- examples/HelloWorld.mq5`, then try any of:

| EA | Strategy / what it shows |
|---|---|
| [`HelloWorld.mq5`](examples/HelloWorld.mq5) | minimal lifecycle (`OnInit`/`OnTick`/`OnDeinit`, prints, no trades) — the "it works" starter |
| [`OpenCloseBtc.mq5`](examples/OpenCloseBtc.mq5) | opens `0.01`, holds 10 s, closes on `OnTimer` — the minimal **live**-trade demo for `npm run ea:live` |
| [`MovingAverageCross.mq5`](examples/MovingAverageCross.mq5) | SMA crossover, flips on the opposite cross |
| [`MacdTrend.mq5`](examples/MacdTrend.mq5) | MACD(12,26,9) trend follower |
| [`TripleMa.mq5`](examples/TripleMa.mq5) | stacked fast/medium/slow SMA system |
| [`AdxTrendFilter.mq5`](examples/AdxTrendFilter.mq5) | MA crossover gated by `iADX` trend strength (multi-buffer) |
| [`RsiBollinger.mq5`](examples/RsiBollinger.mq5) | Bollinger mean-reversion confirmed by RSI |
| [`StochasticScalper.mq5`](examples/StochasticScalper.mq5) | %K/%D cross scalper with ATR brackets |
| [`RsiReversal.mq5`](examples/RsiReversal.mq5) | RSI reversal: ATR-sized pending limits, managed on `OnTimer` |
| [`AtrTrailingStop.mq5`](examples/AtrTrailingStop.mq5) | trend entry + ATR trailing stop (`CPositionInfo` + `PositionModify`) |
| [`ChannelBreakout.mq5`](examples/ChannelBreakout.mq5) | Donchian breakout via pending stop orders |
| [`RawOrderSendGrid.mq5`](examples/RawOrderSendGrid.mq5) | grid built on the raw `OrderSend` + `MqlTradeRequest` API |
| [`OopRiskManaged.mq5`](examples/OopRiskManaged.mq5) | a user `RiskManager` class + `CAccountInfo`/`CSymbolInfo` position sizing |
| [`IcustomMomentum.mq5`](examples/IcustomMomentum.mq5) | loads a custom indicator ([`indicators/MomentumSlope.mq5`](examples/indicators/MomentumSlope.mq5)) via `iCustom` |
| [`IndicatorShowcase.mq5`](examples/IndicatorShowcase.mq5) | `iBands`/`iMACD`/`iStochastic` + `Math*`/`String*` |

> The mean-reversion EAs (RSI-Bollinger, Stochastic) are intentionally **net-negative** on the
> built-in synthetic feed — it's a trend-shaped series, so counter-trend strategies lose. Honest by
> design, not tuned to fake a profit. Point them at real bars and they behave differently.

## How it works

```
.mq5 ─► lexer ─► parser ─► IR ─► TypeScript backend ─► out/<name>.ts
                                                          │  (createExpert factory)
              runtime (MQL5 builtins) + provider boundary │
                                                          ▼
   IBroker / IMarketFeed / IClock ──┬── Backtest provider (sim matching engine + sim clock)
                                    └── Live provider (TickerAll hosted API — any MT4/MT5 broker)
                                          └─► engine driver runs the EA's handlers
```

The transpiled EA calls only **`IBroker` / `IMarketFeed` / `IClock`**, never a concrete broker.
Swapping the implementation swaps **live ↔ backtest** with zero EA changes. There are two axes of
pluggability: target-language backends (TypeScript now; Python later) and broker-egress providers
(TickerAll now; native C/Rust later). See [`CLAUDE.md`](CLAUDE.md) for the full product model.

## Live trading via TickerAll

The live egress is [TickerAll](https://tickerall.com) — a hosted API that connects to any MT4/MT5
broker with just an API key (no MT4/MT5 terminal in the path, nothing private to install). Get a
free key (the free tier covers demo accounts), then run **any** EA live:

```bash
TICKERALL_API_KEY=cf_api_... BROKER_PASSWORD=yourBrokerPassword \
  npm run ea:live -- examples/MovingAverageCross.mq5 \
    --server FBS-Demo --account 12345678 --symbol EURUSD --timeframe M5 --duration 60
```

It transpiles the EA, refuses (with the honesty diagnostics) if it uses an unsupported builtin, then
runs it live — firing `OnTick` on each market tick and `OnTimer` on the timer, against live data and a
real (use a **demo** account first) broker connection. **Secrets are read from the environment only**
(`TICKERALL_API_KEY`, `BROKER_PASSWORD`), never argv.

Under the hood, [`src/runtime/providers/tickerall/`](src/runtime/providers/tickerall) implements the
same `IBroker` / `IMarketFeed` / `IClock` boundary over [`@tickerall/sdk`](https://www.npmjs.com/package/@tickerall/sdk):
`createTickerallProviders(config)` opens the broker session, pre-fetches candle history + symbol specs
(so `IMarketFeed.history()` stays synchronous over the async API), streams live ticks/positions, and
returns the providers + a `disconnect()`. The **same transpiled EA** runs live or in backtest.

### Backtest the history, then continue live — one EA, one session (`--replay-history`)

Add `--replay-history` and `ea:live` runs the EA as **two phases of a single
session**: Phase 1 replays the pre-fetched history as a backtest (printing a
report), then Phase 2 keeps the **same EA instance** running live — its internal
state (indicator handles, counters) carries across the seam unbroken.

```bash
TICKERALL_API_KEY=cf_api_... BROKER_PASSWORD=yourBrokerPassword \
  npm run ea:live -- examples/MovingAverageCross.mq5 \
    --server FBS-Demo --account 12345678 --symbol BTCUSD --timeframe D1 \
    --history 500 --replay-history --duration 60
```

The EA is unchanged — only which providers it resolves to changes at the seam (it
runs over a stable provider facade that flips from the backtest sim to the live
broker). Honest model (see [`engine/replay-live-driver.ts`](src/engine/replay-live-driver.ts)):
`OnInit` fires once at the start, `OnDeinit` once at the end. **Broker state does
not carry** — a paper position from Phase 1 is on the simulated broker; at the
seam the EA's position/account view switches to the **real** account (typically
flat). And the Phase-1 report uses the bar-tier sim (no spread/swap/commission),
so it's an analysis artifact, not a prediction of the live fills.

## Fidelity & limitations (honest)

- **Bar-based tier.** Pending / SL / TP fill intrabar from the bar OHLC — limits fill at the
  trigger price, gaps fill at the gap-open (worse for SL, better for TP), and when SL and TP are
  both inside one bar **SL wins** (conservative). There is **no** spread / swap / commission /
  slippage yet. Tick-accurate is the next fidelity tier.
- **`iATR` is SMA-of-True-Range** — MT5's actual definition (verified against MetaQuotes' `ATR.mq5`),
  *not* Wilder smoothing. `iRSI` *is* Wilder (with MT5's flat-market = 50 / all-up = 100 edge cases).
- **No MT5 Strategy-Tester diff yet.** The intended validation is a trade-for-trade diff against
  MT5's own tester; that oracle isn't wired in (the dev box's MT5 doesn't execute MQL headless).
  Results today are self-consistent and unit-verified, **not** yet tester-validated.

## Scripts

| Script | What it does |
|---|---|
| `npm run ea -- <file.mq5>` | transpile **+ backtest any EA** (your main entry point) |
| `npm run ea:live -- <file.mq5> …` | transpile **+ run any EA LIVE** via TickerAll (env: `TICKERALL_API_KEY`, `BROKER_PASSWORD`) |
| `npm run poc` | the SMA-crossover sample, end-to-end |
| `npm run poc:rsi` | the RSI / pending-orders sample, end-to-end |
| `npm run transpile -- <file.mq5>` | transpile only → `out/<name>.ts` |
| `npm run backtest -- <emitted.ts>` | backtest an already-emitted module |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | the vitest suite |

## Project layout

```
src/
  lexer/       preprocessor + tokenizer
  parser/      AST + recursive-descent parser
  sema/        symbol resolution + intrinsic classification + IR lowering
  ir/          language-neutral IR + the emission ABI
  backend/     IR → TypeScript emitter
  runtime/     MQL5 builtins, indicators, CTrade, constants, the coverage manifest
    providers/   IBroker / IMarketFeed / IClock — backtest + live (TickerAll)
  engine/      backtest driver + report printer
  cli/         ea / ea:live / poc / poc:rsi / transpile / backtest
  diagnostics.ts   the honesty layer (compile-time gap reporting)
examples/      sample EAs (.mq5)
test/          vitest suites
```

## Development

```bash
npm test          # 280 tests
npm run typecheck # strict tsc, no emit
```

Design decisions, the architecture rationale, and the two-deployment product model are documented
in [`CLAUDE.md`](CLAUDE.md).
