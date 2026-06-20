/**
 * Frontend tests — preprocess + tokenize + parse the sample EA.
 *
 * Asserts the syntactic shape the rest of the pipeline depends on:
 *   - the three `input` declarations (InpFastPeriod/InpSlowPeriod/InpLots),
 *   - the three event-handler function declarations (OnInit/OnDeinit/OnTick),
 *   - the OnTick body shape (local arrays, ArraySetAsSeries, CopyBuffer guards,
 *     cross detection, the trade calls).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { tokenize } from '../src/lexer/lexer';
import { preprocess } from '../src/lexer/preprocessor';
import { parse } from '../src/parser/parser';
import { parseProgram } from '../src/compile';
import type {
  Block,
  CallExpr,
  FunctionDecl,
  InputDecl,
  Program,
  VarDecl,
} from '../src/parser/ast';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = resolve(__dirname, '../examples/MovingAverageCross.mq5');
const SAMPLE = readFileSync(SAMPLE_PATH, 'utf8');

function parseSample(): Program {
  return parseProgram(SAMPLE, { name: 'MovingAverageCross', filePath: SAMPLE_PATH });
}

describe('preprocessor', () => {
  it('records #property and #include without emitting them as code', () => {
    const pp = preprocess(SAMPLE, { filePath: SAMPLE_PATH });
    const props = Object.fromEntries(pp.properties.map((p) => [p.name, p.value]));
    expect(props.copyright).toBe('mql5-transpiler PoC');
    expect(props.version).toBe('1.00');
    // `#property strict` has no value.
    expect(pp.properties.some((p) => p.name === 'strict')).toBe(true);

    const sysInc = pp.includes.find((i) => i.system);
    expect(sysInc).toBeDefined();
    expect(sysInc!.path).toBe('Trade/Trade.mqh');
    expect(sysInc!.shimmed).toBe(true);

    // Directive lines are blanked → no '#' survives in the code.
    expect(pp.code.includes('#property')).toBe(false);
    expect(pp.code.includes('#include')).toBe(false);
    // Line count is preserved (directives → blank lines).
    expect(pp.code.split('\n').length).toBe(SAMPLE.split('\n').length);
  });

  it('substitutes object-like #define macros', () => {
    const src = '#define LOTS 0.5\ndouble x = LOTS;\n';
    const pp = preprocess(src);
    expect(pp.code).toContain('0.5');
    expect(pp.code).not.toContain('LOTS');
  });
});

describe('lexer', () => {
  it('tokenises the preprocessed sample and ends with EOF', () => {
    const pp = preprocess(SAMPLE, { filePath: SAMPLE_PATH });
    const toks = tokenize(pp.code);
    expect(toks.length).toBeGreaterThan(50);
    expect(toks[toks.length - 1].kind).toBe('EOF');
    // No stray comment text leaked into tokens.
    expect(toks.some((t) => t.value.includes('Expert tick'))).toBe(false);
  });

  it('lexes numbers, identifiers, keywords and operators', () => {
    const toks = tokenize('int x = 0x1F + 3.5e2; bool b = true && (x >= 10);');
    const kinds = toks.map((t) => t.kind);
    expect(kinds).toContain('Keyword'); // int / bool / true
    expect(kinds).toContain('Identifier'); // x / b
    expect(kinds).toContain('Number');
    expect(kinds).toContain('Operator');
    const nums = toks.filter((t) => t.kind === 'Number').map((t) => t.value);
    expect(nums).toContain('0x1F');
    expect(nums).toContain('3.5e2');
  });

  it('decodes string escapes into the token value', () => {
    const toks = tokenize('"a\\tb\\n";');
    const str = toks.find((t) => t.kind === 'String');
    expect(str?.value).toBe('a\tb\n');
  });

  it('greedily matches multi-char operators', () => {
    const toks = tokenize('a <<= b >>= c <= d;');
    const ops = toks.filter((t) => t.kind === 'Operator').map((t) => t.value);
    expect(ops).toContain('<<=');
    expect(ops).toContain('>>=');
    expect(ops).toContain('<=');
  });

  it('tracks line and column 1-based', () => {
    const toks = tokenize('int a;\n  int b;');
    const b = toks.find((t) => t.kind === 'Identifier' && t.value === 'b');
    expect(b?.line).toBe(2);
    expect(b?.col).toBe(7); // "  int " → b at col 7
  });
});

describe('parser — sample EA', () => {
  it('parses the three input declarations', () => {
    const prog = parseSample();
    const inputs = prog.decls.filter((d): d is InputDecl => d.kind === 'InputDecl');
    const names = inputs.map((i) => i.name);
    expect(names).toEqual(['InpFastPeriod', 'InpSlowPeriod', 'InpLots']);

    const fast = inputs[0];
    expect(fast.modifier).toBe('input');
    expect(fast.type.name).toBe('int');
    expect(fast.init?.kind).toBe('NumberLit');
    expect((fast.init as { value: number }).value).toBe(10);

    const lots = inputs[2];
    expect(lots.type.name).toBe('double');
    expect((lots.init as { value: number; isFloat: boolean }).value).toBeCloseTo(0.1);
    expect((lots.init as { isFloat: boolean }).isFloat).toBe(true);
  });

  it('parses the global var decls and the CTrade object decl', () => {
    const prog = parseSample();
    const vars = prog.decls.filter((d): d is VarDecl => d.kind === 'VarDecl');
    const allNames = vars.flatMap((v) => v.declarators.map((dd) => dd.name));
    expect(allNames).toContain('fastHandle');
    expect(allNames).toContain('slowHandle');
    expect(allNames).toContain('trade');

    const tradeDecl = vars.find((v) => v.declarators.some((dd) => dd.name === 'trade'))!;
    expect(tradeDecl.type.name).toBe('CTrade');
  });

  it('parses the three event handlers with bodies', () => {
    const prog = parseSample();
    const fns = prog.decls.filter((d): d is FunctionDecl => d.kind === 'FunctionDecl');
    const byName = new Map(fns.map((f) => [f.name, f]));
    expect(byName.has('OnInit')).toBe(true);
    expect(byName.has('OnDeinit')).toBe(true);
    expect(byName.has('OnTick')).toBe(true);

    expect(byName.get('OnInit')!.returnType.name).toBe('int');
    expect(byName.get('OnTick')!.returnType.name).toBe('void');
    expect(byName.get('OnInit')!.body).toBeDefined();

    // OnDeinit takes `const int reason`.
    const deinit = byName.get('OnDeinit')!;
    expect(deinit.params.length).toBe(1);
    expect(deinit.params[0].name).toBe('reason');
    expect(deinit.params[0].type.name).toBe('int');
  });

  it('parses the OnTick body shape', () => {
    const prog = parseSample();
    const fns = prog.decls.filter((d): d is FunctionDecl => d.kind === 'FunctionDecl');
    const onTick = fns.find((f) => f.name === 'OnTick')!;
    const body = onTick.body as Block;
    expect(body.kind).toBe('Block');

    // First two statements: `double fast[]; double slow[];`
    const decls = body.statements.filter((s): s is VarDecl => s.kind === 'VarDecl');
    const arrNames = decls.flatMap((d) => d.declarators.map((dd) => dd.name));
    expect(arrNames).toContain('fast');
    expect(arrNames).toContain('slow');
    // arrays: `double fast[]` → one unsized dim (null)
    const fastDecl = decls
      .flatMap((d) => d.declarators)
      .find((dd) => dd.name === 'fast')!;
    expect(fastDecl.arrayDims.length).toBe(1);
    expect(fastDecl.arrayDims[0]).toBeNull();

    // Somewhere a call to ArraySetAsSeries(fast, true).
    const calls = collectCalls(body);
    const calleeNames = calls
      .map((c) => (c.callee.kind === 'Identifier' ? c.callee.name : ''))
      .filter(Boolean);
    expect(calleeNames).toContain('ArraySetAsSeries');
    expect(calleeNames).toContain('CopyBuffer');
    expect(calleeNames).toContain('PositionSelect');
    expect(calleeNames).toContain('PositionGetInteger');

    // trade.Buy / trade.Sell / trade.PositionClose are MemberAccess callees.
    const methodCalls = calls.filter((c) => c.callee.kind === 'MemberAccess');
    const methodNames = methodCalls.map((c) =>
      c.callee.kind === 'MemberAccess' ? c.callee.member : '',
    );
    expect(methodNames).toContain('Buy');
    expect(methodNames).toContain('Sell');
    expect(methodNames).toContain('PositionClose');
  });

  it('attaches a span to every node', () => {
    const prog = parseSample();
    const onTick = prog.decls.find(
      (d): d is FunctionDecl => d.kind === 'FunctionDecl' && d.name === 'OnTick',
    )!;
    expect(onTick.span.start).toBeGreaterThanOrEqual(0);
    expect(onTick.span.end).toBeGreaterThan(onTick.span.start);
    expect(onTick.span.line).toBeGreaterThan(0);
  });
});

describe('parser — expressions & control flow', () => {
  it('parses precedence correctly: a + b * c', () => {
    const prog = parse(tokenize('void f(){ int x = a + b * c; }'));
    const fn = prog.decls[0] as FunctionDecl;
    const stmt = (fn.body as Block).statements[0] as VarDecl;
    const init = stmt.declarators[0].init!;
    expect(init.kind).toBe('BinaryExpr');
    if (init.kind === 'BinaryExpr') {
      expect(init.op).toBe('+');
      expect(init.right.kind).toBe('BinaryExpr'); // b * c binds tighter
      if (init.right.kind === 'BinaryExpr') expect(init.right.op).toBe('*');
    }
  });

  it('parses ternary and assignment right-associativity', () => {
    const prog = parse(tokenize('void f(){ x = a ? b : c; }'));
    const fn = prog.decls[0] as FunctionDecl;
    const exprStmt = (fn.body as Block).statements[0];
    expect(exprStmt.kind).toBe('ExprStmt');
    if (exprStmt.kind === 'ExprStmt') {
      expect(exprStmt.expr.kind).toBe('AssignExpr');
      if (exprStmt.expr.kind === 'AssignExpr') {
        expect(exprStmt.expr.value.kind).toBe('TernaryExpr');
      }
    }
  });

  it('parses a C-style cast', () => {
    const prog = parse(tokenize('void f(){ double d = (double)x; }'));
    const fn = prog.decls[0] as FunctionDecl;
    const decl = (fn.body as Block).statements[0] as VarDecl;
    expect(decl.declarators[0].init?.kind).toBe('CastExpr');
  });

  it('parses for/while/if/switch', () => {
    const src = `void f(){
      for(int i=0;i<10;i++){ if(i>5) break; else continue; }
      while(x){ x--; }
      switch(k){ case 1: g(); break; default: h(); }
    }`;
    const prog = parse(tokenize(src));
    const fn = prog.decls[0] as FunctionDecl;
    const stmts = (fn.body as Block).statements;
    expect(stmts[0].kind).toBe('ForStmt');
    expect(stmts[1].kind).toBe('WhileStmt');
    expect(stmts[2].kind).toBe('SwitchStmt');
  });

  it('parses multiple declarators: double a[], b;', () => {
    const prog = parse(tokenize('void f(){ double a[], b; }'));
    const fn = prog.decls[0] as FunctionDecl;
    const decl = (fn.body as Block).statements[0] as VarDecl;
    expect(decl.declarators.length).toBe(2);
    expect(decl.declarators[0].name).toBe('a');
    expect(decl.declarators[0].arrayDims.length).toBe(1);
    expect(decl.declarators[1].name).toBe('b');
    expect(decl.declarators[1].arrayDims.length).toBe(0);
  });

  it('parses enum declarations', () => {
    const prog = parse(tokenize('enum Color { RED, GREEN=5, BLUE };'));
    const e = prog.decls[0];
    expect(e.kind).toBe('EnumDecl');
    if (e.kind === 'EnumDecl') {
      expect(e.name).toBe('Color');
      expect(e.members.map((m) => m.name)).toEqual(['RED', 'GREEN', 'BLUE']);
    }
  });
});

// ── helpers ──

function collectCalls(node: Block): CallExpr[] {
  const out: CallExpr[] = [];
  const walkExpr = (e: unknown): void => {
    if (!e || typeof e !== 'object') return;
    const node = e as { kind?: string };
    if (node.kind === 'CallExpr') out.push(e as CallExpr);
    for (const v of Object.values(e as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(walkExpr);
      else if (v && typeof v === 'object') walkExpr(v);
    }
  };
  walkExpr(node);
  return out;
}
