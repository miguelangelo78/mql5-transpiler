/**
 * MQL5 Math* host helpers — pure, MT5-exact semantics (global CLAUDE.md §21).
 *
 * These are the kernel `Math*` builtins (NOT the C++ Standard Library). They
 * perform no I/O; each is a pure function the runtime delegates to (the same
 * pattern as `arrayResize`/`computeATR`). The integrator wires each onto
 * `RuntimeImpl` as `MathXxx(...) { return mathXxx(...); }`.
 *
 * Where JS `Math` already matches MT5 bit-for-bit (abs/ceil/floor/sqrt/pow/
 * exp/log/sin/cos/tan), we forward to it — MT5's `Math*` are the same IEEE-754
 * double ops, so this is exact, not an approximation. The non-trivial ones are
 * documented inline:
 *
 *   - MathRound  → round HALF AWAY FROM ZERO (MT5), NOT banker's rounding and
 *                  NOT JS `Math.round` (which rounds half toward +∞: rounds
 *                  -2.5 to -2, while MT5 → -3).
 *   - MathMod    → `fmod(a,b)` — IEEE remainder with the sign of the DIVIDEND
 *                  (NOT JS `%`'s coercions; for doubles JS `%` IS fmod, so we
 *                  use it, but document the contract).
 *   - MathRand   → int in [0, 32767] (MT5 RAND_MAX = 0x7fff) via the classic
 *                  MSVC LCG, seeded deterministically (see MathRandState).
 */

/** MathAbs — absolute value. JS `Math.abs` is IEEE-exact (abs(-0)=+0, abs(NaN)=NaN). */
export function MathAbs(x: number): number {
  return Math.abs(x);
}

/** MathCeil — round toward +∞. */
export function MathCeil(x: number): number {
  return Math.ceil(x);
}

/** MathFloor — round toward -∞. */
export function MathFloor(x: number): number {
  return Math.floor(x);
}

/**
 * MathRound — round to nearest integer, ties HALF AWAY FROM ZERO.
 *
 * MT5: MathRound(2.5) = 3, MathRound(-2.5) = -3, MathRound(2.4) = 2.
 * JS `Math.round` rounds ties toward +∞ (Math.round(-2.5) === -2) — WRONG for
 * MT5 — so we implement the away-from-zero rule explicitly.
 */
export function MathRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/**
 * MathMax — larger of two. MT5 `MathMax(a,b)` is a 2-arg numeric max.
 * (MT5 also has a templated form; the transpiled call is always 2 doubles.)
 * NaN handling mirrors MT5/C `fmax`-like "the non-NaN wins"? — MT5 actually
 * returns the raw comparison result; we keep JS `Math.max` (NaN propagates),
 * which matches MT5's observable double-compare for finite inputs (the only
 * inputs EAs feed it).
 */
export function MathMax(a: number, b: number): number {
  return Math.max(a, b);
}

/** MathMin — smaller of two (see MathMax note). */
export function MathMin(a: number, b: number): number {
  return Math.min(a, b);
}

/** MathPow — base^exponent. JS `Math.pow` is IEEE-exact (== C `pow`). */
export function MathPow(base: number, exponent: number): number {
  return Math.pow(base, exponent);
}

/** MathSqrt — square root (NaN for x<0, as in MT5). */
export function MathSqrt(x: number): number {
  return Math.sqrt(x);
}

/** MathExp — e^x. */
export function MathExp(x: number): number {
  return Math.exp(x);
}

/** MathLog — natural log (ln). MT5 `MathLog` is the natural logarithm. */
export function MathLog(x: number): number {
  return Math.log(x);
}

/** MathSin — sine (radians). */
export function MathSin(x: number): number {
  return Math.sin(x);
}

/** MathCos — cosine (radians). */
export function MathCos(x: number): number {
  return Math.cos(x);
}

/** MathTan — tangent (radians). */
export function MathTan(x: number): number {
  return Math.tan(x);
}

/**
 * MathMod — floating-point remainder of `a / b`, with the SIGN OF THE DIVIDEND
 * (C `fmod` semantics). MT5: MathMod(7.5, 2) = 1.5; MathMod(-7.5, 2) = -1.5;
 * MathMod(7.5, -2) = 1.5. JS `%` on doubles is exactly `fmod`, so we forward.
 */
export function MathMod(a: number, b: number): number {
  return a % b;
}

/**
 * Deterministic MathRand state — the classic MSVC `rand()` LCG that MT5's
 * `MathRand`/`MathSrand` use:
 *     seed = seed * 214013 + 2531011   (mod 2^32)
 *     rand = (seed >> 16) & 0x7fff     → [0, 32767]
 *
 * Seed source (documented): the module owns a 32-bit seed defaulting to
 * MT5's well-known default of 1 (C stdlib `srand` default). `mathSrand(seed)`
 * sets it; `MathRand()` advances it and returns the next value. This makes the
 * sequence DETERMINISTIC and reproducible (tests seed it, then assert the
 * exact stream). The runtime can expose `MathSrand` later; for the host module
 * the seed is process-global per the C/MT5 model.
 */
class MathRandState {
  /** MT5/C default seed before any MathSrand call is 1. */
  private seed = 1 >>> 0;

  /** MathSrand(seed) — set the LCG seed (mirrors MT5 MathSrand). */
  srand(seed: number): void {
    this.seed = (Math.trunc(seed) >>> 0);
  }

  /** MathRand() — next pseudo-random int in [0, 32767]. */
  next(): number {
    // 32-bit LCG step (MSVC constants). Use Math.imul for exact 32-bit mul.
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }
}

/** Process-global RNG state (C/MT5 model: one global seed). */
const RAND = new MathRandState();

/**
 * MathSrand — seed the deterministic RNG (MT5 `MathSrand`). Exposed so the
 * runtime/tests can reset the stream to a known starting point.
 */
export function mathSrand(seed: number): void {
  RAND.srand(seed);
}

/**
 * MathRand — pseudo-random integer in [0, 32767] (MT5 RAND_MAX = 0x7fff).
 * Deterministic given the current seed (default 1; set via `mathSrand`).
 */
export function MathRand(): number {
  return RAND.next();
}
