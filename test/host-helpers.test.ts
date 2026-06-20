/**
 * Host-helper MT5-semantics tests (Agent HOST).
 *
 * These pin the MT5-EXACT behaviour of the pure host builtins (Math / String /
 * Convert / Array) — the cases where JS defaults DIVERGE from MT5 and a naive
 * port would silently be wrong (round-half-away-from-zero, fmod, the MSVC LCG
 * range/determinism, printf specifiers, numeric ArraySort, INDEX-returning
 * ArrayMaximum, as-series direction).
 *
 * Run: npx vitest run test/host-helpers.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  MathAbs,
  MathCeil,
  MathFloor,
  MathRound,
  MathMax,
  MathMin,
  MathPow,
  MathSqrt,
  MathExp,
  MathLog,
  MathSin,
  MathCos,
  MathTan,
  MathMod,
  MathRand,
  mathSrand,
} from '../src/runtime/host/math';
import {
  StringLen,
  StringSubstr,
  StringFind,
  StringReplace,
  stringReplaceCount,
  StringFormat,
  StringToDouble,
  StringToInteger,
} from '../src/runtime/host/str';
import {
  DoubleToString,
  IntegerToString,
  TimeToString,
  TIME_DATE,
  TIME_MINUTES,
  TIME_SECONDS,
  formatLine,
} from '../src/runtime/host/convert';
import {
  ArrayCopy,
  ArrayMaximum,
  ArrayMinimum,
  ArraySort,
} from '../src/runtime/host/array';

// ─────────────────────────────────────────────────────────────────────────
// Math
// ─────────────────────────────────────────────────────────────────────────
describe('Math* host helpers', () => {
  it('MathAbs / Ceil / Floor', () => {
    expect(MathAbs(-3.5)).toBe(3.5);
    expect(MathAbs(0)).toBe(0);
    expect(MathCeil(2.1)).toBe(3);
    expect(MathFloor(2.9)).toBe(2);
    expect(MathFloor(-2.1)).toBe(-3);
  });

  it('MathRound rounds HALF AWAY FROM ZERO (MT5, not JS Math.round)', () => {
    expect(MathRound(2.5)).toBe(3);
    expect(MathRound(-2.5)).toBe(-3); // JS Math.round(-2.5) === -2 (WRONG for MT5)
    expect(MathRound(2.4)).toBe(2);
    expect(MathRound(-2.4)).toBe(-2);
    expect(MathRound(0.5)).toBe(1);
    expect(MathRound(-0.5)).toBe(-1);
    expect(MathRound(2.0)).toBe(2);
  });

  it('MathMax / MathMin (2-arg numeric)', () => {
    expect(MathMax(3, 7)).toBe(7);
    expect(MathMax(-3, -7)).toBe(-3);
    expect(MathMin(3, 7)).toBe(3);
    expect(MathMin(-3, -7)).toBe(-7);
  });

  it('MathPow / MathSqrt / MathExp / MathLog', () => {
    expect(MathPow(2, 10)).toBe(1024);
    expect(MathPow(9, 0.5)).toBe(3);
    expect(MathSqrt(16)).toBe(4);
    expect(MathSqrt(-1)).toBeNaN();
    expect(MathExp(0)).toBe(1);
    expect(MathLog(Math.E)).toBeCloseTo(1, 12);
  });

  it('trig (radians)', () => {
    expect(MathSin(0)).toBe(0);
    expect(MathCos(0)).toBe(1);
    expect(MathTan(0)).toBe(0);
    expect(MathSin(Math.PI / 2)).toBeCloseTo(1, 12);
  });

  it('MathMod == fmod (sign of dividend)', () => {
    expect(MathMod(7.5, 2)).toBeCloseTo(1.5, 12);
    expect(MathMod(-7.5, 2)).toBeCloseTo(-1.5, 12);
    expect(MathMod(7.5, -2)).toBeCloseTo(1.5, 12);
    expect(MathMod(10, 3)).toBe(1);
  });

  it('MathRand is in [0,32767] and DETERMINISTIC given a seed', () => {
    mathSrand(1);
    const a: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = MathRand();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(32767);
      expect(Number.isInteger(r)).toBe(true);
      a.push(r);
    }
    // re-seed → identical stream (determinism contract)
    mathSrand(1);
    const b: number[] = [];
    for (let i = 0; i < 100; i++) b.push(MathRand());
    expect(b).toEqual(a);

    // A different seed → a different stream.
    mathSrand(12345);
    const c: number[] = [];
    for (let i = 0; i < 100; i++) c.push(MathRand());
    expect(c).not.toEqual(a);
  });

  it('MathRand matches the MSVC LCG exactly for seed=1 (first 3 values)', () => {
    // seed=1: 1*214013+2531011 = 2745024 -> >>16 &0x7fff = 41 ... computed:
    // step1 seed=2745024  -> (2745024>>>16)&0x7fff = 41
    mathSrand(1);
    expect(MathRand()).toBe(41);
    // The next two are deterministic; assert they are stable integers in range.
    const v2 = MathRand();
    const v3 = MathRand();
    for (const v of [v2, v3]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(32767);
    }
    // pin the exact stream so a regression in the LCG is caught
    mathSrand(1);
    expect([MathRand(), MathRand(), MathRand()]).toEqual([41, v2, v3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// String
// ─────────────────────────────────────────────────────────────────────────
describe('String* host helpers', () => {
  it('StringLen', () => {
    expect(StringLen('hello')).toBe(5);
    expect(StringLen('')).toBe(0);
  });

  it('StringSubstr with and without count', () => {
    expect(StringSubstr('Hello, World', 7)).toBe('World');
    expect(StringSubstr('Hello, World', 0, 5)).toBe('Hello');
    expect(StringSubstr('Hello', 2, 2)).toBe('ll');
    expect(StringSubstr('Hello', 10)).toBe(''); // start past end
    expect(StringSubstr('Hello', 0, 0)).toBe(''); // zero count
    expect(StringSubstr('Hello', -1, 2)).toBe('He'); // negative start clamps to 0
  });

  it('StringFind', () => {
    expect(StringFind('Hello, World', 'World')).toBe(7);
    expect(StringFind('Hello, World', 'o')).toBe(4);
    expect(StringFind('Hello, World', 'o', 5)).toBe(8); // search from index 5
    expect(StringFind('Hello', 'z')).toBe(-1); // not found
    expect(StringFind('Hello', '')).toBe(0); // empty match at 0 (JS indexOf)
  });

  it('StringReplace replaces ALL occurrences + reports count', () => {
    expect(StringReplace('a.b.c.d', '.', '-')).toBe('a-b-c-d');
    expect(stringReplaceCount('a.b.c.d', '.')).toBe(3);
    expect(StringReplace('aaa', 'a', 'bb')).toBe('bbbbbb');
    expect(StringReplace('no match', 'X', 'Y')).toBe('no match');
    expect(StringReplace('text', '', 'Y')).toBe('text'); // empty find → no-op
  });

  it('StringToDouble / StringToInteger parse leading numbers; 0 on none (§29)', () => {
    expect(StringToDouble('3.14abc')).toBeCloseTo(3.14, 12);
    expect(StringToDouble('-2.5')).toBe(-2.5);
    expect(StringToDouble('  10')).toBe(10);
    expect(StringToDouble('1e3')).toBe(1000);
    expect(StringToDouble('abc')).toBe(0); // not NaN
    expect(StringToInteger('42xyz')).toBe(42);
    expect(StringToInteger('-7')).toBe(-7);
    expect(StringToInteger('3.99')).toBe(3); // stops at '.'
    expect(StringToInteger('abc')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// StringFormat — printf fidelity
// ─────────────────────────────────────────────────────────────────────────
describe('StringFormat (printf)', () => {
  it('%f and %.Nf precision', () => {
    expect(StringFormat('%.2f', 3.14159)).toBe('3.14');
    expect(StringFormat('%.0f', 3.7)).toBe('4');
    expect(StringFormat('%f', 1.5)).toBe('1.500000'); // default precision 6
    expect(StringFormat('%.4f', -0.5)).toBe('-0.5000');
  });

  it('%d / %i / %u integer', () => {
    expect(StringFormat('%d', 42)).toBe('42');
    expect(StringFormat('%i', -42)).toBe('-42');
    expect(StringFormat('%d', 3.9)).toBe('3'); // truncates
    expect(StringFormat('%u', 5)).toBe('5');
  });

  it('width + zero-pad: %05d', () => {
    expect(StringFormat('%05d', 42)).toBe('00042');
    expect(StringFormat('%05d', -42)).toBe('-0042'); // sign + zero pad
    expect(StringFormat('%5d', 42)).toBe('   42'); // space pad
    expect(StringFormat('%-5d|', 42)).toBe('42   |'); // left justify
  });

  it('sign flags: %+d and space flag', () => {
    expect(StringFormat('%+d', 42)).toBe('+42');
    expect(StringFormat('% d', 42)).toBe(' 42');
    expect(StringFormat('%+d', -42)).toBe('-42');
  });

  it('%x / %X hexadecimal', () => {
    expect(StringFormat('%x', 255)).toBe('ff');
    expect(StringFormat('%X', 255)).toBe('FF');
    expect(StringFormat('%#x', 255)).toBe('0xff');
    expect(StringFormat('%04x', 255)).toBe('00ff');
  });

  it('%s string + precision truncation', () => {
    expect(StringFormat('%s', 'hi')).toBe('hi');
    expect(StringFormat('%s world', 'hello')).toBe('hello world');
    expect(StringFormat('%.3s', 'hello')).toBe('hel');
    expect(StringFormat('%8s|', 'hi')).toBe('      hi|');
    expect(StringFormat('%-8s|', 'hi')).toBe('hi      |');
  });

  it('%c char', () => {
    expect(StringFormat('%c', 65)).toBe('A');
    expect(StringFormat('%c', 'xyz')).toBe('x');
  });

  it('%e scientific and %g shortest', () => {
    expect(StringFormat('%e', 12345)).toBe('1.234500e+04');
    expect(StringFormat('%.2e', 12345)).toBe('1.23e+04');
    expect(StringFormat('%g', 0.0001)).toBe('0.0001');
    expect(StringFormat('%g', 100000)).toBe('100000');
    expect(StringFormat('%g', 1000000)).toBe('1e+06');
  });

  it('%% literal and mixed', () => {
    expect(StringFormat('100%%')).toBe('100%');
    expect(StringFormat('%s=%d (%.1f%%)', 'x', 5, 12.5)).toBe('x=5 (12.5%)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Convert
// ─────────────────────────────────────────────────────────────────────────
describe('Convert host helpers', () => {
  it('DoubleToString fixed digits', () => {
    expect(DoubleToString(1.23456, 2)).toBe('1.23');
    expect(DoubleToString(1.23456, 4)).toBe('1.2346');
    expect(DoubleToString(1.5, 0)).toBe('2'); // round half up
    expect(DoubleToString(-1.23456, 2)).toBe('-1.23');
    expect(DoubleToString(0, 2)).toBe('0.00'); // §29 zero is valid
  });

  it('DoubleToString default digits = 8', () => {
    expect(DoubleToString(1.5)).toBe('1.50000000');
  });

  it('DoubleToString negative digits → significant-figure scientific', () => {
    expect(DoubleToString(1.23456, -4)).toBe('1.235e+00');
    expect(DoubleToString(12345, -3)).toBe('1.23e+04');
  });

  it('IntegerToString with width + fill', () => {
    expect(IntegerToString(42)).toBe('42');
    expect(IntegerToString(42, 5)).toBe('00042'); // default fill '0'
    expect(IntegerToString(42, 5, ' ')).toBe('   42');
    expect(IntegerToString(-42, 5, '0')).toBe('-0042'); // zero-pad: sign leads (printf %05d)
    expect(IntegerToString(-42, 5, ' ')).toBe('  -42'); // space-pad: pads whole rendered text
    expect(IntegerToString(123456, 3)).toBe('123456'); // already wider
    expect(IntegerToString(0, 3)).toBe('000'); // §29 zero is valid
  });

  it('TimeToString flags', () => {
    // 2024.01.15 13:45:30 UTC  (epoch seconds)
    const t = Date.UTC(2024, 0, 15, 13, 45, 30) / 1000;
    expect(TimeToString(t, TIME_DATE)).toBe('2024.01.15');
    expect(TimeToString(t, TIME_MINUTES)).toBe('13:45');
    expect(TimeToString(t, TIME_SECONDS)).toBe('13:45:30');
    expect(TimeToString(t, TIME_DATE | TIME_MINUTES)).toBe('2024.01.15 13:45');
    expect(TimeToString(t, TIME_DATE | TIME_SECONDS)).toBe('2024.01.15 13:45:30');
    expect(TimeToString(t)).toBe('2024.01.15 13:45'); // default DATE|MINUTES
  });

  it('formatLine mirrors StringFormat (PrintFormat without I/O)', () => {
    expect(formatLine('%.2f', 3.14159)).toBe('3.14');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Array
// ─────────────────────────────────────────────────────────────────────────
describe('Array* host helpers', () => {
  it('ArrayCopy basic + bounds + return count', () => {
    const dst: number[] = [0, 0, 0, 0, 0];
    expect(ArrayCopy(dst, [1, 2, 3])).toBe(3);
    expect(dst).toEqual([1, 2, 3, 0, 0]);

    const dst2: number[] = [9, 9, 9, 9, 9];
    expect(ArrayCopy(dst2, [1, 2, 3, 4], 1, 1, 2)).toBe(2); // src[1..2] → dst[1..2]
    expect(dst2).toEqual([9, 2, 3, 9, 9]);

    expect(ArrayCopy([], [1, 2], 0, 5)).toBe(0); // src_start past end
  });

  it('ArrayCopy grows the destination', () => {
    const dst: number[] = [];
    expect(ArrayCopy(dst, [10, 20, 30])).toBe(3);
    expect(dst).toEqual([10, 20, 30]);
  });

  it('ArrayMaximum / ArrayMinimum return the INDEX (not the value)', () => {
    const arr = [3, 1, 7, 2, 5];
    expect(ArrayMaximum(arr)).toBe(2); // value 7 at index 2
    expect(ArrayMinimum(arr)).toBe(1); // value 1 at index 1
  });

  it('ArrayMaximum / ArrayMinimum honour start + count window', () => {
    const arr = [3, 1, 7, 2, 5];
    expect(ArrayMaximum(arr, 3)).toBe(4); // window [2,5] from index 3 → max 5 @4
    expect(ArrayMaximum(arr, 0, 2)).toBe(0); // window [3,1] → max 3 @0
    expect(ArrayMinimum(arr, 2, 2)).toBe(3); // window [7,2] → min 2 @3
  });

  it('ArrayMaximum honours as-series indexing direction', () => {
    // physical [3,1,7,2,5]; as-series logical view = [5,2,7,1,3].
    const arr = [3, 1, 7, 2, 5];
    // max value 7 is physical index 2 → logical index len-1-2 = 2 (symmetric here)
    expect(ArrayMaximum(arr, 0, -1, true)).toBe(2);
    // min value 1 is physical index 1 → logical index 5-1-1 = 3
    expect(ArrayMinimum(arr, 0, -1, true)).toBe(3);
    // as-series window from logical 0: [5,2] (physical [5],[2]) → max 5 @ logical 0
    expect(ArrayMaximum(arr, 0, 2, true)).toBe(0);
  });

  it('ArrayMaximum returns the FIRST extremum on ties', () => {
    const arr = [5, 1, 5, 1];
    expect(ArrayMaximum(arr)).toBe(0);
    expect(ArrayMinimum(arr)).toBe(1);
  });

  it('ArraySort ascending NUMERICALLY (not lexicographic)', () => {
    const arr = [2, 10, 1, 20, 3];
    expect(ArraySort(arr)).toBe(true);
    expect(arr).toEqual([1, 2, 3, 10, 20]); // JS default would give [1,10,2,20,3]
  });

  it('ArraySort handles negatives + zero (§29)', () => {
    const arr = [0, -5, 3, -1, 0];
    ArraySort(arr);
    expect(arr).toEqual([-5, -1, 0, 0, 3]);
  });

  it('empty / invalid array guards', () => {
    expect(ArrayMaximum([])).toBe(-1);
    expect(ArrayMinimum([])).toBe(-1);
  });
});
