/**
 * Custom-indicator compiler + runner — the engine behind `iCustom`.
 *
 * `iCustom(symbol, timeframe, "Name", ...params)` runs the user's OWN custom
 * indicator. A custom indicator is itself an MQL5 program with `OnInit`
 * (registers its output buffers via `SetIndexBuffer`) and `OnCalculate` (fills
 * those buffers per bar). This module:
 *
 *   compileCustomIndicator(name)  — resolve <indicatorsDir>/<name>.mq5, run the
 *     SAME frontend + TypeScript backend the EA uses (../compile.ts +
 *     ../backend/typescript/emit.ts), and dynamic-import the emitted module to
 *     obtain its `createExpert` factory. Done ONCE per indicator (cached upstream).
 *
 *   runCustomIndicator(compiled, {feed, ctx, params, bars}) — instantiate the
 *     factory against a MINIMAL INDICATOR RUNTIME, call OnInit() (which records
 *     buffer index → array via SetIndexBuffer), call OnCalculate() over the bars,
 *     and read the filled buffer arrays back out. Returns the buffers (each a
 *     chronological array, index i = bar i).
 *
 * ── How SetIndexBuffer / INDICATOR_DATA / EMPTY_VALUE reach the emitted code ──
 *
 * `SetIndexBuffer` and the `INDICATOR_*` selector constants are indicator-only
 * MQL5 builtins. The shared frontend does not yet recognise them, so the emitter
 * prints `SetIndexBuffer(...)` as a bare call and `INDICATOR_DATA` as a bare
 * name. We make those resolve WITHOUT editing the shared frontend by prepending
 * a small PRELUDE to the emitted module that defines them at module scope (the
 * `createExpert` closure picks them up lexically). The prelude routes
 * `SetIndexBuffer` to a per-run host installed via `__setIndicatorHost`, and runs
 * are strictly synchronous + single-threaded (OnInit → OnCalculate, no awaits —
 * indicators never trade), so there is no reentrancy hazard.
 *
 * Preferred long-term wiring (handoff): add `SetIndexBuffer` to the intrinsic
 * table and `INDICATOR_*` to the constants table, so they emit as `rt.…` like
 * every other builtin; this prelude is then redundant. Until then it keeps the
 * iCustom feature fully self-contained + testable.
 *
 * ── OnCalculate signatures supported (honest scope — §21) ──
 *   LONG form (10 params): (rates_total, prev_calculated, time[], open[], high[],
 *     low[], close[], tick_volume[], volume[], spread[]).  ← most indicators.
 *   SHORT form (4 params): (rates_total, prev_calculated, begin, price[]) — price
 *     defaults to PRICE_CLOSE (we feed the close series; an indicator applied to
 *     a non-close price is a chart-attach-time choice MT5 makes, NOT visible in
 *     the .mq5 source, so PRICE_CLOSE is the faithful default).
 * Any other arity is reported loudly (we do NOT guess a mapping).
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

import { compileMql5ToIR } from '../compile';
import { emitTypeScript } from '../backend/typescript/emit';
import { createRuntime } from '../runtime/index';
import type { IRModule } from '../ir/nodes';
import type { Bar, IMarketFeed } from '../runtime/providers/types';
import type { RuntimeContext } from '../engine/types';

// NOTE on the import cycle: when the integrator wires `rt.iCustom` into the
// runtime, `runtime/index.ts` → `runtime/indicators/icustom.ts` → here →
// `runtime/index.ts` forms an ES-module cycle. This is SAFE: the only thing we
// import from the runtime barrel is `createRuntime`, a live binding that is
// CALLED only at run time (inside runCustomIndicator), never during module
// evaluation — so the cycle resolves with no half-initialised reference.

/** Default directory custom indicators resolve against. */
const DEFAULT_INDICATORS_DIR = resolve('examples/indicators');

/** MT5 EMPTY_VALUE (DBL_MAX) — the no-value sentinel buffers report. */
const EMPTY_VALUE = Number.MAX_VALUE;

/** Numeric ids for the INDICATOR_* buffer-kind selectors (internal dispatch). */
const INDICATOR_DATA = 0;
const INDICATOR_CALCULATIONS = 1;
const INDICATOR_COLOR_INDEX = 2;

/** A trailing iCustom parameter (becomes one of the indicator's `input`s). */
export type CustomIndicatorParam = number | boolean | string;

/** A compiled custom indicator (transpiled + imported, ready to instantiate). */
export interface CompiledCustomIndicator {
  /** Indicator name (the `name` passed to iCustom). */
  name: string;
  /** Resolved absolute path of the .mq5 source. */
  sourcePath: string;
  /** The IR module (carries the input list, in declaration order). */
  module: IRModule;
  /** The imported factory: createExpert(rt, inputs). */
  factory: IndicatorFactory;
  /** Names of the declared `input`s, in source order (maps positional params). */
  inputNames: string[];
}

/** The factory shape an emitted indicator module exports. */
type IndicatorFactory = (rt: unknown, inputs?: Record<string, unknown>) => IndicatorInstance;

/** The instance an indicator factory returns (OnInit + OnCalculate). */
interface IndicatorInstance {
  OnInit?: () => number | void;
  OnDeinit?: (reason: number) => void;
  OnCalculate?: (...args: unknown[]) => number;
  __inputs: Record<string, unknown>;
}

export interface CompileCustomIndicatorOptions {
  /** Directory to resolve `<name>.mq5` against (default examples/indicators). */
  indicatorsDir?: string;
}

/**
 * Resolve, transpile and import the named custom indicator.
 *
 * Throws (does NOT return a half-built handle) when the source is missing, is a
 * compiled `.ex5` (out of scope), or fails to compile — §21: a custom indicator
 * we cannot back must surface as a failure, not a fake success.
 */
export function compileCustomIndicator(
  name: string,
  opts: CompileCustomIndicatorOptions = {},
): CompiledCustomIndicator {
  const dir = opts.indicatorsDir ?? DEFAULT_INDICATORS_DIR;
  const sourcePath = resolveIndicatorSource(name, dir);

  const source = readFileSync(sourcePath, 'utf8');
  const module = compileMql5ToIR(source, { name, filePath: sourcePath });

  // A custom indicator MUST have an OnCalculate (that is what produces buffers).
  if (module.events.OnCalculate === undefined) {
    throw new Error(
      `iCustom: '${name}' (${sourcePath}) has no OnCalculate — it is not a ` +
        `custom indicator this engine can run.`,
    );
  }

  // Honest gate: a custom indicator that uses a builtin the runtime cannot back
  // would throw mid-OnCalculate. We surface only the source-level compile
  // diagnostics (unresolved names / unknown calls) — EXCEPT the indicator-only
  // SetIndexBuffer / INDICATOR_* names, which the prelude provides. Coverage of
  // ordinary builtins is checked by the caller's pipeline (checkCoverage); here
  // we fail fast on a HARD frontend error that isn't one of those prelude names.
  const hardErrors = (module.diagnostics ?? []).filter(
    (d) => d.severity === 'error' && !isPreludeProvidedName(d.symbol),
  );
  if (hardErrors.length > 0) {
    const lines = hardErrors.map((d) => `  - ${d.code}: ${d.message}`).join('\n');
    throw new Error(
      `iCustom: '${name}' has unresolved source errors that would throw at run ` +
        `time:\n${lines}`,
    );
  }

  const code = wrapWithPrelude(emitTypeScript(module));
  const factory = importFactory(code, name);
  const inputNames = module.inputs.map((i) => i.name);

  return { name, sourcePath, module, factory, inputNames };
}

export interface RunCustomIndicatorArgs {
  feed: IMarketFeed;
  ctx: RuntimeContext;
  /** Trailing iCustom params, positional → the indicator's inputs in order. */
  params: CustomIndicatorParam[];
  /** The bars OnCalculate runs over (chronological, oldest→newest). */
  bars: readonly Bar[];
}

export interface RunCustomIndicatorResult {
  /**
   * The indicator's output buffers, in SetIndexBuffer index order. Each is a
   * chronological array (index i = bar i). Slots the indicator never wrote are
   * `undefined`; warm-up slots a faithful indicator writes are EMPTY_VALUE.
   */
  buffers: (number | undefined)[][];
}

/**
 * Run a compiled custom indicator over `args.bars` and return its filled
 * buffers. Synchronous + side-effect-free w.r.t. the caller (a fresh instance +
 * fresh buffers each call).
 */
export function runCustomIndicator(
  compiled: CompiledCustomIndicator,
  args: RunCustomIndicatorArgs,
): RunCustomIndicatorResult {
  const host = new IndicatorHost();
  const rt = makeIndicatorRuntime(args.feed, args.ctx, host);

  // Map positional iCustom params → the indicator's inputs (declaration order).
  const inputs: Record<string, unknown> = {};
  for (let i = 0; i < compiled.inputNames.length && i < args.params.length; i++) {
    inputs[compiled.inputNames[i]!] = args.params[i];
  }

  // Install the host for the prelude's SetIndexBuffer to find, then instantiate.
  setActiveHost(host);
  try {
    const instance = compiled.factory(rt, inputs);

    // OnInit registers buffers via SetIndexBuffer(idx, arrayRef, kind).
    if (instance.OnInit !== undefined) {
      instance.OnInit();
    }

    // Drive OnCalculate with the correct signature shape.
    if (instance.OnCalculate !== undefined) {
      const callArgs = buildOnCalculateArgs(compiled, args.bars);
      instance.OnCalculate(...callArgs);
    }
    return { buffers: host.readBuffers() };
  } finally {
    setActiveHost(null);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// OnCalculate argument shaping
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the positional arguments for OnCalculate based on its arity.
 * rates_total = bars.length; prev_calculated = 0 (we always recompute the whole
 * series — a full recalculation, exactly what MT5 does on the first call / a
 * history change; faithful and avoids any incremental-state divergence).
 */
function buildOnCalculateArgs(
  compiled: CompiledCustomIndicator,
  bars: readonly Bar[],
): unknown[] {
  const ratesTotal = bars.length;
  const prevCalculated = 0;

  const time = bars.map((b) => b.time);
  const open = bars.map((b) => b.open);
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const tickVolume = bars.map((b) => b.tickVolume);
  const realVolume = bars.map((b) => b.realVolume);
  const spread = bars.map((b) => b.spread);

  const arity = onCalculateArity(compiled);
  switch (arity) {
    case 10:
      // LONG form: (rates_total, prev_calculated, time, open, high, low, close,
      //             tick_volume, volume, spread).
      return [
        ratesTotal,
        prevCalculated,
        time,
        open,
        high,
        low,
        close,
        tickVolume,
        realVolume,
        spread,
      ];
    case 4:
      // SHORT form: (rates_total, prev_calculated, begin, price). begin = 0
      // (no leading no-value region from an upstream indicator); price = close
      // (the faithful default — see file header).
      return [ratesTotal, prevCalculated, 0, close];
    default:
      throw new Error(
        `iCustom: '${compiled.name}' OnCalculate has ${arity} parameters; only ` +
          `the standard SHORT (4) and LONG (10) forms are supported (§21 — the ` +
          `engine does not guess a non-standard OnCalculate signature).`,
      );
  }
}

/** The parameter count of the indicator's OnCalculate (from the IR). */
function onCalculateArity(compiled: CompiledCustomIndicator): number {
  const fnName = compiled.module.events.OnCalculate;
  const fn = compiled.module.functions.find((f) => f.name === fnName);
  return fn ? fn.params.length : -1;
}

// ─────────────────────────────────────────────────────────────────────────
// The indicator host (buffer registry) + the prelude wiring
// ─────────────────────────────────────────────────────────────────────────

/**
 * Records buffer-index → the live array the indicator fills. The array is the
 * SAME reference the emitted module's closure holds, so after OnCalculate writes
 * `ExtBuffer[i] = …`, we read those values back through this map.
 */
class IndicatorHost {
  private buffers = new Map<number, unknown[]>();

  setIndexBuffer(index: number, array: unknown, _kind: number): boolean {
    if (!Array.isArray(array)) return false;
    if (!Number.isInteger(index) || index < 0) return false;
    this.buffers.set(index, array);
    return true;
  }

  /** Read all registered buffers as a dense array (index 0..maxIndex). */
  readBuffers(): (number | undefined)[][] {
    if (this.buffers.size === 0) return [];
    let max = 0;
    for (const k of this.buffers.keys()) if (k > max) max = k;
    const out: (number | undefined)[][] = [];
    for (let i = 0; i <= max; i++) {
      const arr = this.buffers.get(i);
      out.push(arr ? (arr.map(toNumberOrUndefined) as (number | undefined)[]) : []);
    }
    return out;
  }
}

function toNumberOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/**
 * Module-level active host. The prelude's SetIndexBuffer routes here. Runs are
 * synchronous + single-threaded so a single active host is safe; we install it
 * for the duration of one run and clear it after.
 */
let activeHost: IndicatorHost | null = null;
function setActiveHost(h: IndicatorHost | null): void {
  activeHost = h;
}
/** Called by the emitted prelude. Exported on globalThis (see wrapWithPrelude). */
function preludeSetIndexBuffer(index: number, array: unknown, kind: number): boolean {
  if (activeHost === null) {
    throw new Error('iCustom internal: SetIndexBuffer called with no active host');
  }
  return activeHost.setIndexBuffer(index, array, kind);
}

/**
 * The names the PRELUDE provides at module scope (so the emitted closure resolves
 * them). A frontend diagnostic about one of these is expected + harmless (the
 * prelude supplies it), so compileCustomIndicator does not treat it as a hard
 * error.
 */
const PRELUDE_NAMES: ReadonlySet<string> = new Set<string>([
  'SetIndexBuffer',
  'INDICATOR_DATA',
  'INDICATOR_CALCULATIONS',
  'INDICATOR_COLOR_INDEX',
]);
function isPreludeProvidedName(symbol: string | undefined): boolean {
  return symbol !== undefined && PRELUDE_NAMES.has(symbol);
}

/**
 * A globalThis key the prelude calls through. Using globalThis (rather than an
 * import) keeps the emitted module a standalone file with no import of this
 * compiler — it only needs the well-known global, which we set here.
 */
const HOST_GLOBAL_KEY = '__mql5IcustomSetIndexBuffer';
(globalThis as Record<string, unknown>)[HOST_GLOBAL_KEY] = preludeSetIndexBuffer;

/**
 * Prepend the indicator prelude to the emitted module source. Defines the
 * indicator-only builtins the closure references as bare names:
 *   - SetIndexBuffer(idx, arr, kind) → routes to the active host via globalThis.
 *   - INDICATOR_DATA / INDICATOR_CALCULATIONS / INDICATOR_COLOR_INDEX → ids.
 * These are module-scope `const`/`function` decls placed BEFORE `createExpert`,
 * so its closure binds them lexically.
 */
function wrapWithPrelude(emitted: string): string {
  const prelude = [
    '// ── iCustom prelude (indicator-only builtins; see src/icustom/compile.ts) ──',
    `const INDICATOR_DATA = ${INDICATOR_DATA};`,
    `const INDICATOR_CALCULATIONS = ${INDICATOR_CALCULATIONS};`,
    `const INDICATOR_COLOR_INDEX = ${INDICATOR_COLOR_INDEX};`,
    `function SetIndexBuffer(index, array, kind) {`,
    `  return globalThis[${JSON.stringify(HOST_GLOBAL_KEY)}](index, array, kind);`,
    '}',
    '',
  ].join('\n');
  return prelude + emitted;
}

// ─────────────────────────────────────────────────────────────────────────
// The minimal indicator runtime
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `rt` an indicator's `createExpert` receives. An indicator needs FAR less
 * than an EA: it reads bars / symbol / time, does math/array/string work, and
 * fills buffers — it never trades. We reuse the FULL runtime (createRuntime over
 * the same feed) for all the read + helper builtins, plus a no-broker
 * clock/broker shim so createRuntime can be constructed. This guarantees every
 * indicator builtin (CopyClose, iMA, ArraySetAsSeries, Math*, …) behaves exactly
 * as it does for an EA — no reimplementation, no drift (§21/§33).
 */
function makeIndicatorRuntime(
  feed: IMarketFeed,
  ctx: RuntimeContext,
  _host: IndicatorHost,
): unknown {
  const providers = {
    feed,
    clock: { now: () => currentBarTime(feed, ctx) },
    broker: makeNoTradeBroker(),
  };
  return createRuntime(providers as never, ctx);
}

/** The newest visible bar's time (the indicator's "current time"). */
function currentBarTime(feed: IMarketFeed, ctx: RuntimeContext): number {
  const bars = feed.history(ctx.symbol, ctx.timeframe);
  return bars.length > 0 ? bars[bars.length - 1]!.time : 0;
}

/**
 * A broker that performs no trades — an indicator never calls one, but
 * createRuntime constructs PositionState/OrderState/HistoryState over it. All
 * trade methods throw (they must never be reached on an indicator path); reads
 * return empty (an indicator that queried positions would get the honest "none").
 */
function makeNoTradeBroker(): unknown {
  const reject = (): never => {
    throw new Error('iCustom: a custom indicator must not place trades');
  };
  return {
    placeMarketOrder: reject,
    modifyPosition: reject,
    closePosition: reject,
    getPosition: () => null,
    positions: () => [],
    account: () => ({
      login: 0,
      currency: 'USD',
      leverage: 0,
      balance: 0,
      equity: 0,
      margin: 0,
      freeMargin: 0,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Source resolution + import
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve a custom-indicator name to its .mq5 source path.
 *   - An absolute / relative path ending in .mq5 is used directly.
 *   - A bare name resolves to `<dir>/<name>.mq5`.
 *   - A `.ex5` (compiled, no source) is explicitly OUT OF SCOPE — reported
 *     loudly (§21) rather than silently failing.
 */
function resolveIndicatorSource(name: string, dir: string): string {
  if (/\.ex5$/i.test(name)) {
    throw new Error(
      `iCustom: '${name}' is a compiled .ex5 with no source — out of scope. ` +
        `Provide the .mq5 source to transpile it.`,
    );
  }

  // Explicit path (absolute or has a separator / .mq5 extension).
  if (isAbsolute(name) || name.includes('/') || /\.mq5$/i.test(name)) {
    const p = isAbsolute(name) ? name : resolve(name);
    if (existsSync(p)) return p;
    // Try with .mq5 appended if it was given without the extension.
    if (!/\.mq5$/i.test(p) && existsSync(p + '.mq5')) return p + '.mq5';
    throw new Error(`iCustom: indicator source not found: ${p}`);
  }

  const candidate = join(dir, `${name}.mq5`);
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `iCustom: indicator '${name}' not found at ${candidate} ` +
      `(searched indicatorsDir=${dir}).`,
  );
}

/**
 * Synchronously obtain `createExpert` from the emitted code.
 *
 * The registry's lazy-compile path is SYNCHRONOUS (iCustom / CopyBuffer are sync
 * reads — see ../runtime/runtime.ts async discipline), so we cannot use a dynamic
 * `import()` (async). The emitted module is plain JS — `export function
 * createExpert(...)` plus the prelude (plain decls) — so we strip the lone
 * `export` keyword and evaluate the body in an isolated function scope, returning
 * the factory. `globalThis` (for the prelude's host call) is visible inside.
 *
 * We optionally persist the emitted source to a temp file for debuggability; the
 * factory itself comes from the in-memory eval (not from importing that file).
 */
function importFactory(code: string, name: string): IndicatorFactory {
  // Persist for inspection (not loaded back — the factory is eval'd in-memory).
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mql5-icustom-'));
    writeFileSync(join(dir, `${safeFileStem(name)}.mjs`), code, 'utf8');
  } catch {
    /* best-effort debug artifact; ignore fs failures */
  }

  // Strip the ESM `export ` so `createExpert` is a local we can return. The
  // emitted module declares exactly one export: `export function createExpert`.
  const body = code.replace(/^\s*export\s+function\s+createExpert/m, 'function createExpert');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(`${body}\nreturn createExpert;`);
  const factory = make() as unknown;
  if (typeof factory !== 'function') {
    throw new Error(`iCustom: emitted module for '${name}' did not yield createExpert`);
  }
  return factory as IndicatorFactory;
}

function safeFileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export { EMPTY_VALUE, INDICATOR_DATA };
