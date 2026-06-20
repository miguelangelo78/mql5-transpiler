# CLAUDE.md — mql5-transpiler

Design notes and architecture for this project. (See `README.md` for usage.)

## What this is

A transpiler that reads **MQL5** source (MetaTrader 5's language) and emits an
equivalent program in a target language (**TypeScript** first), which runs on a
pluggable **engine**: backtested against history, or live against a real broker.

MQL5 is large and C++-like. The parser/codegen is the easy ~30%; the **runtime
that re-implements MQL5's built-ins (indicators, trading, timeseries, the
Standard Library) is the ~70%** — that's where the real work and the fidelity
risk live.

## Architecture — two axes of pluggability

1. **Target-language backends.** A shared frontend lowers MQL5 → a
   **language-neutral IR**; pluggable backends emit the IR to a target language.
   **TypeScript first**; Python (and others) later. The IR marks
   **I/O-performing intrinsics** (trades) so each backend emits the right call
   shape (TS emits `await broker.place(...)`; a sync backend emits a blocking
   call).
2. **Broker-egress providers.** The transpiled EA and the built-ins runtime call
   only the provider boundary — `IBroker` / `IMarketFeed` / `IClock` — never a
   concrete broker. Implementations:
   - **Backtest provider** — deterministic historical replay + a simulated
     matching engine + a sim clock (offline).
   - **Live provider via TickerAll** — the hosted MT4/MT5 API
     (`@tickerall/sdk`), reachable with just an API key. Future: native C/Rust
     wire-protocol egresses behind the same boundary.

Swapping the provider swaps **live ↔ backtest** with zero changes to the
transpiled EA.

### Pipeline

```
MQL5 source (.mq5 / .mqh)
  → lexer (after a preprocessor pass: #include/#define/#property)
  → parser            (C++-ish grammar: classes, enums, structs, arrays, pointers)
  → semantic analysis (symbol binding, intrinsic classification)
  → IR                (typed, language-neutral; built-ins kept as intrinsics)
  → backend codegen   (IR → TypeScript)
  → runtime library   (MQL5 built-ins on the provider boundary)
  → driver            (backtest: step bars; live: event-driven on ticks/timer)
```

## The honesty layer

`src/diagnostics.ts` + `src/runtime/coverage.ts` (`RUNTIME_COVERAGE` +
`checkCoverage`): an EA that uses a recognised-but-unimplemented builtin is
caught at **compile time** (a clear diagnostic + non-zero exit), never a silent
runtime throw. `npm run ea` reports exactly what (if anything) your EA needs that
isn't supported yet. Never mark a stub as covered, and never fake a value —
report the gap.

## Runtime fidelity — the hard 70%

1. **Indicators must match MT5 exactly.** Replicate MetaTrader's *documented*
   recurrences, not textbook formulas. Notably **`iATR` is an SMA of True Range,
   not Wilder**; `iRSI` *is* Wilder (with the flat-market = 50 / all-up = 100
   edge cases). `iMA` covers SMA/EMA/SMMA(=Wilder RMA)/LWMA; `iBands`/`iMACD`/
   `iStochastic`/`iADX`/`iCCI`/`iMomentum` are implemented with source-faithful
   buffer numbering. Verify against an independent reference, including warm-up.
2. **Execution model.** MQL5 assumes a synchronous trade server, a netting
   position model, and one bound (symbol, timeframe) chart context. The runtime
   projects that onto async providers; only trade calls are async.
3. **The C++ surface.** Classes, enums, structs, object-pointers, the Standard
   Library (`CTrade`, indicator handles). Coverage is a scope dial, not
   all-or-nothing — the honesty layer keeps it truthful.

## Validation

The intended oracle is **MT5's own Strategy Tester**: transpile an EA, run our
backtest on the same bars, and diff trades trade-for-trade. Backtest-first makes
this cheap and front-loads correctness; the tester diff is a planned next step.
Until then, results are self-consistent and unit-verified, **not** yet
tester-validated.

## Fidelity tier & honest limitations

- **Bar-based tier.** Pending / SL / TP fill intrabar from the bar OHLC (limits
  at the trigger price; gaps at the gap-open; SL-first when both hit one bar).
  **No** spread / swap / commission / slippage yet — tick-accurate is the next
  tier.
- **Not yet implemented** (caught at compile time): `iCustom`, raw `OrderSend`, a
  few `CTrade` methods, user classes-with-methods / templates. The exact
  implemented set is `src/runtime/coverage.ts`.

## Working in this repo

- Strict TypeScript, ESM, `tsx` runner, `vitest` tests.
- `npm run typecheck` · `npm test` · `npm run ea -- <file.mq5>` (backtest) ·
  `npm run ea:live -- <file.mq5> …` (live via TickerAll).
- Keep the honesty layer truthful: a new builtin is "covered" only when it's
  really implemented and added to `RUNTIME_COVERAGE`.
- Match the surrounding code's style; replicate MT5 semantics exactly, never
  approximate a behaviour the engine claims to mirror.
