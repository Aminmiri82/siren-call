import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrap,
  compile,
  compileUsing,
  runCompiled,
  runtimeURL,
} from '../dist/compiler/index.js';
import { execute, SingError } from '../dist/sing/index.js';
import { runSing } from '../dist/sing-runner.js';
import { compilerLimits, limits } from '../dist/selection.js';
import type { Scalar } from '../dist/sing/types.js';

const exec = promisify(execFile);
const cli = new URL('../dist/compiler/cli.js', import.meta.url).pathname;
let stages: Awaited<ReturnType<typeof bootstrap>>;
beforeAll(async () => {
  stages = await bootstrap();
}, 30_000);

const cases: [string, string, Scalar][] = [
  ['exact integers', 'RETURN 9007199254740992 + 1;', 9007199254740993n],
  ['leading zero literals', 'RETURN 00042;', 42n],
  ['decimal arithmetic', 'RETURN 1.25 + 2.5;', 3.75],
  ['negative decimal zero', 'RETURN -0.0;', -0],
  ['short circuiting', 'RETURN (FALSE AND missing()) OR TRUE;', true],
  ['boolean operations', 'RETURN (TRUE XOR FALSE) AND NOT FALSE;', true],
  ['null', 'RETURN NULL;', null],
  ['legacy precedence', 'RETURN (1 + 2) > 2;', true],
  ['separate numeric kinds', 'RETURN 1 == 1.0;', false],
  ['Unicode strings and escapes', 'RETURN "\\ud83d\\ude00" + "café\\n\\t\\u0000";', '😀café\n\t\0'],
  ['unpaired UTF-16 units', 'RETURN "\\ud800";', '\ud800'],
  ['quote and backslash escapes', 'RETURN "\\\"\\\\\\/\\b\\f\\r";', '"\\/\b\f\r'],
  [
    'safe source quoting',
    'RETURN "` ${process.env} </script> \\";";',
    '` ${process.env} </script> ";',
  ],
  [
    'lexical scope',
    'LET n = 10; FUNC f(x) { RETURN n + x; } FUNC g() { LET n = 100; RETURN f(1); } RETURN g();',
    11n,
  ],
  [
    'escaping closures',
    'FUNC factory(n: Int) { FUNC next(): Int { n = n + 1; RETURN n; } RETURN next; } LET a = factory(1); LET b = factory(10); a(); RETURN a() + b();',
    14n,
  ],
  [
    'recursion',
    'FUNC sum(n: Int): Int { IF n == 0 { RETURN 0; } RETURN n + sum(n - 1); } RETURN sum(10);',
    55n,
  ],
  [
    'mutual recursion',
    'FUNC even(n) { IF n == 0 { RETURN TRUE; } RETURN odd(n - 1); } FUNC odd(n) { IF n == 0 { RETURN FALSE; } RETURN even(n - 1); } RETURN even(8);',
    true,
  ],
  ['captured later binding', 'LET n = 1; FUNC f() { RETURN n; } n = 42; RETURN f();', 42n],
  ['NULL fallthrough', 'FUNC f(): Null {} RETURN f();', null],
  [
    'immutable append',
    'LET a = [{value: 1}]; LET b = APPEND(a, {value: 2}); a = []; RETURN COUNT(b) + b[0].value;',
    3n,
  ],
  [
    'prototype-like keys',
    'LET x = {"__proto__": {constructor: "safe"}}; RETURN x["__proto__"].constructor;',
    'safe',
  ],
  [
    'computed calls',
    'FUNC inc(x) { RETURN x + 1; } LET xs = [{apply: inc}]; RETURN xs[0].apply(41);',
    42n,
  ],
  ['first-class built-ins', 'LET size = COUNT; RETURN size([1, 2, 3]);', 3n],
  [
    'nested loop returns',
    'FUNC find() { FOR x IN [-1, 42] { WHILE x > 0 { RETURN x; } } RETURN 0; } RETURN find() + 1;',
    43n,
  ],
  [
    'stable iteration',
    'LET xs = [1, 2, 3]; LET sum = 0; FOR x IN xs { xs = []; sum = sum + x; } RETURN sum;',
    6n,
  ],
  [
    'per-iteration closures',
    'LET fs = []; FOR n IN [1, 2] { FUNC f() { RETURN n; } fs = APPEND(fs, f); } RETURN fs[0]() + fs[1]();',
    3n,
  ],
  [
    'annotations and aliases',
    'TYPE T = {value: Int}; TYPE Ts = List<T>; FUNC f(x: Ts): Int { RETURN x[0].value; } RETURN f([{value: 42, extra: TRUE}]);',
    42n,
  ],
  [
    'lexical aliases',
    'TYPE T = Int; FUNC f(x: T): T { RETURN x; } IF TRUE { TYPE T = String; RETURN f(42); } RETURN 0;',
    42n,
  ],
  ['unused type mismatch', 'FUNC f(): Int { RETURN "bad"; } RETURN 42;', 42n],
  ['dynamic bindings', 'LET x = 1; x = "yes"; RETURN x;', 'yes'],
  [
    'legacy blocks and keyword case',
    'func f(x) do if x > 0 then return x else return 0 end end; return f(42)',
    42n,
  ],
  ['multiline literals', 'LET x = [\n {a: [1, 2,],},\n]; RETURN x[0].a[1];', 2n],
  ['newline ELSE', 'IF FALSE { RETURN 1; }\nELSE { RETURN 42; }', 42n],
  ['JSON-escaped field names', 'RETURN {"a": 42}["\\u0061"];', 42n],
  ['string tools', 'RETURN SLICE("hello", 1, 4) + CHAR(111);', 'ello'],
  [
    'exact conversion and code units',
    'RETURN INT("+9007199254740993") + CHAR_CODE("a");',
    9007199254741090n,
  ],
];

describe('self-hosted Sing compiler', () => {
  it('rebuilds itself identically through two generated compilers', () => {
    expect(stages.stage1).toBe(stages.stage2);
    expect(stages.stage2).toBe(stages.stage3);
    expect(stages.stage3).toContain('export default function run');
  });

  it.each(cases)('matches the interpreter for %s', async (_name, source, expected) => {
    expect(execute(source, { limits }).value).toBe(expected);
    const generated = await compileUsing(stages.stage3, source);
    expect(await runCompiled(generated)).toBe(expected);
  });

  it('produces the same target program with the seed and every compiler stage', async () => {
    const source = 'TYPE T = {n: Int}; FUNC f(x: T): Int { RETURN x.n; } RETURN f({n: 42});';
    const seed = await compile(source);
    for (const compiler of Object.values(stages)) {
      const generated = await compileUsing(compiler, source);
      expect(generated).toBe(seed);
      expect(await runCompiled(generated)).toBe(42n);
    }
  });

  it.each([
    ['type', 'LET x: Int = "bad"; RETURN x;'],
    ['type', 'LET x: Int = 1; FUNC f() { x = FALSE; } f(); RETURN x;'],
    ['type', 'FUNC f(x: Int) { x = "bad"; } f(1); RETURN 0;'],
    ['type', 'FUNC f(): Int { RETURN "bad"; } RETURN f();'],
    ['type', 'FUNC f(): Int {} RETURN f();'],
    ['type', 'LET x: List<Int> = [1, "bad"]; RETURN 0;'],
    ['type', 'LET x: {a: Int} = {}; RETURN 0;'],
    ['type', 'RETURN 1 + 1.0;'],
    ['type', 'RETURN 1 < 1.0;'],
    ['type', 'RETURN 1 + 2 > 2;'],
    ['type', 'RETURN [] == [];'],
    ['type', 'RETURN [1];'],
    ['type', 'LET f = 1; RETURN f();'],
    ['type', 'RETURN [1][0.0];'],
    ['index', 'RETURN [1][-1];'],
    ['index', 'RETURN [1][9007199254740993];'],
    ['field', 'RETURN {}.constructor;'],
    ['number', 'RETURN INT("1.0");'],
    ['character', 'RETURN CHAR(65536);'],
    ['character', 'RETURN CHAR_CODE("😀");'],
    ['user-error', 'ERROR("deliberate"); RETURN 1;'],
    ['unknown-type', 'TYPE T = List<T>; RETURN 0;'],
    ['duplicate-type', 'TYPE Int = String; RETURN 0;'],
    ['unknown-variable', 'x = 1; RETURN x;'],
    ['unknown-variable', 'IF TRUE { LET x = 1; } RETURN x;'],
    ['duplicate-variable', 'LET x = 1; LET x = 2; RETURN x;'],
    ['arguments', 'FUNC f(x) {} RETURN f();'],
    ['function', 'RETURN later(); FUNC later() { RETURN 1; }'],
    ['missing-result', 'LET x = 1;'],
  ])('preserves %s failures for %s', async (code, source) => {
    expect(() => execute(source, { limits })).toThrow(SingError);
    try {
      execute(source, { limits });
    } catch (error) {
      expect((error as SingError).diagnostic.code).toBe(code);
    }
    await expect(runCompiled(await compileUsing(stages.stage3, source))).rejects.toMatchObject({
      name: 'SingError',
      diagnostic: { code },
    });
  });

  it('keeps diagnostic spans on target source after compilation and worker transport', async () => {
    const source = 'LET x: Int = 1;\nx = "bad"; RETURN x;';
    try {
      await runCompiled(await compile(source));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SingError);
      const { start, end } = (error as SingError).diagnostic;
      expect(source.slice(start, end)).toBe('"bad"');
      expect((error as Error).message).toContain('Line 2, column 5');
    }
  });

  it.each([
    'LET = 1;',
    'RETURN 1; LET =',
    'RETURN "\\q";',
    'RETURN "\\u00zz";',
    'FUNC f(x, x) {} RETURN 1;',
    'RETURN {a: 1, "\\u0061": 2};',
    'LET x = [1]; x[0] = 2;',
    'IF TRUE { RETURN 1;',
    'LET x = 1 RETURN x;',
    'RETURN 1e3;',
    'RETURN café;',
    'PING NONE SAYING "hi";',
    'RETURN @everyone;',
  ])('rejects invalid or unsupported input without executing it: %s', async source => {
    await expect(compileUsing(stages.stage3, source)).rejects.toMatchObject({
      name: 'SingError',
      diagnostic: { code: 'compile-syntax' },
    });
    await expect(compile(source)).rejects.toMatchObject({
      name: 'SingError',
      diagnostic: { code: 'compile-syntax' },
    });
  });

  it('locates compilation errors in the input file rather than compiler.sing', async () => {
    const source = '# first line\nRETURN @everyone;';
    try {
      await compile(source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SingError);
      const diagnostic = (error as SingError).diagnostic;
      expect(source.slice(diagnostic.start, diagnostic.end)).toBe('@');
      expect((error as Error).message).toContain('Line 2, column 8');
    }
  });

  it('starts workers with an empty environment and kills code that bypasses work accounting', async () => {
    // Native fixtures exercise the worker boundary itself, independently of generated guards.
    expect(await runCompiled('export default () => Object.keys(process.env).length;')).toBe(0);
    await expect(runCompiled('export default function () { while (true) {} }')).rejects.toThrow(
      'execution time limit',
    );
    expect(await runCompiled(await compile('RETURN 42;'))).toBe(42n);
  });

  it('bounds compiled execution, shared call work, and dynamically nested values', async () => {
    for (const source of [
      'FUNC f() {} WHILE TRUE { f(); }',
      'LET x = []; WHILE TRUE { x = APPEND(x, 1); }',
    ])
      await expect(
        runCompiled(await compile(source), { executionLimits: { ...limits, singSteps: 100 } }),
      ).rejects.toMatchObject({ diagnostic: { code: 'step-limit' } });
    for (const source of [
      'FUNC f() { RETURN f(); } RETURN f();',
      'LET x = []; WHILE TRUE { x = [x]; }',
    ])
      await expect(runCompiled(await compile(source))).rejects.toMatchObject({
        diagnostic: { code: 'depth-limit' },
      });
    await expect(
      runCompiled(await compile('RETURN COUNT([1, 2, 3]);'), {
        executionLimits: { ...limits, singCollectionItems: 2 },
      }),
    ).rejects.toMatchObject({ diagnostic: { code: 'collection-limit' } });
    expect(await runCompiled(await compile('RETURN 42;'))).toBe(42n);
  });

  it('does not expose host capabilities through generated expressions', async () => {
    for (const source of [
      'RETURN process.env;',
      'RETURN require("node:fs");',
      'FUNC f() {} RETURN f.constructor;',
      'RETURN "x".constructor;',
    ]) {
      await expect(runCompiled(await compile(source))).rejects.toThrow();
    }
    const source =
      'LET x = {"constructor": "safe", "__proto__": "plain"}; RETURN x.constructor + x["__proto__"];';
    expect(await runCompiled(await compile(source))).toBe('safeplain');
  });

  it('keeps the compiler profile separate from the normal interpreter', async () => {
    const source = '# ' + 'x'.repeat(limits.sourceBytes) + '\nRETURN 42;';
    await expect(runSing(source)).rejects.toThrow('too large');
    const generated = await compile(source);
    await expect(runCompiled(generated)).rejects.toThrow('too large');
    expect(await runCompiled(generated, { profile: 'compiler' })).toBe(42n);
    await expect(compile('x'.repeat(compilerLimits.sourceBytes + 1))).rejects.toThrow(
      'source size limit',
    );
  });

  it('passes only explicit scalar input bindings to the seed and generated compiler', async () => {
    const generated = await compile('RETURN SOURCE;');
    expect(execute('RETURN SOURCE;', { limits, globals: { SOURCE: 'input' } }).value).toBe('input');
    expect(await runCompiled(generated, { globals: { SOURCE: 'input' } })).toBe('input');
    await expect(runCompiled(generated)).rejects.toThrow('Unknown variable');
    expect(stages.stage1).toContain(runtimeURL);
  });
});

describe('compiler CLI', () => {
  it('writes a runnable module, runs in a worker, and refuses to overwrite an output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sing-compiler-'));
    try {
      const input = join(dir, 'input.sing'),
        output = join(dir, 'output.mjs');
      await writeFile(input, 'RETURN 9007199254740992 + 1;');
      expect((await exec(process.execPath, [cli, input, '-o', output])).stdout).toBe('');
      expect((await exec(process.execPath, [output])).stdout).toBe('9007199254740993\n');
      expect((await exec(process.execPath, [cli, input, '--run'])).stdout).toBe(
        '9007199254740993\n',
      );
      const saved = await readFile(output, 'utf8');
      await expect(exec(process.execPath, [cli, input, '-o', output])).rejects.toMatchObject({
        code: 1,
      });
      expect(await readFile(output, 'utf8')).toBe(saved);
      const printed = await exec(process.execPath, [cli, input]);
      expect(printed.stdout).toBe(saved);
      expect(printed.stderr).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports invalid source and malformed UTF-8 without writing an artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sing-compiler-errors-'));
    try {
      const input = join(dir, 'input.sing'),
        output = join(dir, 'output.mjs');
      for (const content of ['LET =', Buffer.from([0xff])]) {
        await writeFile(input, content);
        await expect(exec(process.execPath, [cli, input, '-o', output])).rejects.toMatchObject({
          code: 1,
          stdout: '',
        });
        await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect((await exec(process.execPath, [cli, '--help'])).stdout).toContain('Usage:');
      await expect(exec(process.execPath, [cli])).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
