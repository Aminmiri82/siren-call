import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { execute, SingError } from '../dist/sing/index.js';
import { runSing } from '../dist/sing-runner.js';
import { limits } from '../dist/selection.js';
import { SingSelectionLanguage } from '../dist/languages/sing/index.js';

const run = (source: string) => execute(source, { limits });
const exec = promisify(execFile);
const cli = new URL('../dist/sing-cli.js', import.meta.url).pathname;
const example = new URL('../examples/counter.sing', import.meta.url).pathname;

/** Each CLI case needs its own source file, so the temporary directory is per-test. */
async function withSourceFile<T>(
  source: string | Buffer,
  body: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'sing-cli-'));
  const file = join(directory, 'input.sing');
  try {
    await writeFile(file, source);
    return await body(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('standalone Sing', () => {
  it('computes exactly beyond binary64 precision', async () => {
    const source = 'RETURN 9007199254740992 + 1';
    expect(run(source)).toEqual({ kind: 'return', value: 9007199254740993n });
    // The worker boundary must not round the result down to a double on the way back.
    expect(await runSing(source)).toEqual({ kind: 'return', value: 9007199254740993n });
    expect(run('RETURN -9007199254740993 - 1').value).toBe(-9007199254740994n);
    expect(run('RETURN 9007199254740993 > 9007199254740992').value).toBe(true);
    expect(run('RETURN TEXT(9007199254740993)').value).toBe('9007199254740993');
    expect(run('RETURN COUNT(NONE) == 0').value).toBe(true);
  });

  it('defines decimal arithmetic and cross-type equality without rounding integers', () => {
    expect(run('RETURN 1.5 + 2.0').value).toBe(3.5);
    expect(run('RETURN 1 == 1.0').value).toBe(false);
    expect(() => run('RETURN 1 + 1.0')).toThrow('Cannot mix');
    expect(() => run('RETURN 1 < 1.0')).toThrow('Compare');
    expect(() => run('RETURN ' + '9'.repeat(400) + '.0')).toThrow('non-finite');
  });

  it('returns scalars through nested scopes and loops and parses unreachable source', () => {
    for (const [source, value] of [
      ['FALSE', false],
      ['NULL', null],
      ['0', 0n],
      ['""', ''],
    ] as const)
      expect(run(`WHILE TRUE DO IF TRUE THEN RETURN ${source} END END`).value).toBe(value);
    expect(() => run('RETURN 1; LET =')).toThrow(SingError);
    expect(() => run('RETURN NONE')).toThrow('scalar');
    expect(() => run('LET x = 1')).toThrow('without a result');
    expect(run('LET x = 1; IF TRUE THEN LET x = 2; x = 3 END; RETURN x').value).toBe(1n);
    expect(run('RETURN FALSE AND unknown').value).toBe(false);
    expect(run('RETURN TRUE OR unknown').value).toBe(true);
  });

  it('preserves legacy precedence explicitly', () => {
    expect(run('RETURN (1 + 2) > 2').value).toBe(true);
    expect(() => run('RETURN 1 + 2 > 2')).toThrow();
    expect(run('RETURN TRUE OR FALSE AND FALSE').value).toBe(true);
  });

  it('bounds integer growth and accounts for operand size and conversion', () => {
    const smallLimits = { ...limits, singIntegerDigits: 3 };
    const bounded = (source: string) => execute(source, { limits: smallLimits });
    expect(() => bounded('RETURN 1000')).toThrow('integer is too large');
    expect(() => bounded('LET x = 999; RETURN x + 1')).toThrow('integer is too large');
    expect(() => execute('LET n = 1; WHILE TRUE DO n = n + n END', { limits })).toThrow(
      /step limit|integer is too large/,
    );
    const source = `LET n = ${'9'.repeat(200)}; WHILE TRUE DO LET same = n == n END`;
    expect(() => execute(source, { limits: { ...limits, singSteps: 500 } })).toThrow('step limit');
    expect(() =>
      execute('RETURN TEXT(1000)', { limits: { ...limits, singStringLength: 3 } }),
    ).toThrow('string is too large');
    expect(() => execute('RETURN 1', { limits: { ...limits, singSteps: Infinity } })).toThrow(
      'Invalid Sing limit',
    );
  });

  it.each([
    ['module loading', 'RETURN require("fs")'],
    ['host globals', 'RETURN process.env'],
    ['Discord-only statements', 'PING NONE SAYING "hi"'],
  ])('denies a standalone script %s', async (_case, source) => {
    await expect(runSing(source)).rejects.toThrow();
  });

  it('terminates a runaway standalone script and stays usable', async () => {
    await expect(runSing('WHILE TRUE DO END')).rejects.toThrow(/step limit|time limit/);
    await expect(runSing('RETURN 42')).resolves.toEqual({ kind: 'return', value: 42n });
  });

  it('carries diagnostic spans across the worker boundary', async () => {
    const source = 'LET café = 1\nRETURN café + 1.0';
    try {
      await runSing(source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SingError);
      const diagnostic = (error as SingError).diagnostic;
      expect(source.slice(diagnostic.start, diagnostic.end)).toBe('café + 1.0');
      expect((error as Error).message).toContain('Line 2, column 8');
    }
  });

  it('keeps Discord plans separate from standalone return values', async () => {
    const adapter = new SingSelectionLanguage();
    const context = { members: [], roles: [], messages: [], callerId: '1' };
    await expect(adapter.compile('RETURN 1', context)).rejects.toThrow('must produce PING');
    expect(await adapter.compile('PING NONE SAYING TEXT(9007199254740992 + 1)', context)).toEqual({
      recipients: [],
      message: '9007199254740993',
    });
  });

  it.each([
    ['FALSE', { type: 'boolean', value: false }],
    ['NULL', { type: 'null', value: null }],
    ['"hello"', { type: 'string', value: 'hello' }],
    ['1.5', { type: 'decimal', value: 1.5 }],
    ['0', { type: 'integer', value: '0' }],
  ])('serializes %s as JSON that keeps its kind', async (expression, expected) => {
    await withSourceFile(`RETURN ${expression}`, async file => {
      const result = await exec(process.execPath, [cli, '--json', file]);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    });
  });

  it.each([
    ['an unknown variable', 'RETURN missing', 'Line 1, column 8'],
    ['source over the size limit', '#' + 'x'.repeat(limits.sourceBytes), 'too large'],
    ['bytes that are not text', Buffer.from([0xff]), 'encoded data'],
  ])('fails with a diagnostic on stderr for %s', async (_case, source, diagnostic) => {
    await withSourceFile(source, async file => {
      await expect(exec(process.execPath, [cli, file])).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining(diagnostic),
      });
    });
  });

  it('runs the counter example through the CLI with lossless JSON output', async () => {
    expect(run(readFileSync(example, 'utf8')).value).toBe(9007199254741004n);
    const plain = await exec(process.execPath, [cli, example]);
    expect(plain.stdout).toBe('9007199254741004\n');
    expect(plain.stderr).toBe('');
    const json = await exec(process.execPath, [cli, '--json', example]);
    expect(JSON.parse(json.stdout)).toEqual({ type: 'integer', value: '9007199254741004' });
    expect((await exec(process.execPath, [cli, '--help'])).stdout).toContain('Usage:');
    await expect(exec(process.execPath, [cli])).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('Usage:'),
    });
    await expect(exec(process.execPath, [cli, example + '.missing'])).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
  });
});

type Instruction =
  | { counter: 'a' | 'b'; kind: 'inc'; next: number }
  | { counter: 'a' | 'b'; kind: 'dec'; next: number; zero: number };

function translate(program: Instruction[], a: bigint, b: bigint): string {
  return `LET a = ${a}; LET b = ${b}; LET pc = 1
WHILE pc != 0 DO
LET instruction = pc
${program
  .map(
    (op, i) => `IF instruction == ${i + 1} THEN
${op.kind === 'inc' ? `${op.counter} = ${op.counter} + 1; pc = ${op.next}` : `IF ${op.counter} == 0 THEN pc = ${op.zero} ELSE ${op.counter} = ${op.counter} - 1; pc = ${op.next} END`}
END`,
  )
  .join('\n')}
END
RETURN TEXT(a) + "," + TEXT(b)`;
}

it('agrees with an independent counter-machine model for all halting small cases', () => {
  const instructions: Instruction[] = [];
  for (const counter of ['a', 'b'] as const) {
    for (let next = 0; next <= 2; next++) {
      instructions.push({ counter, kind: 'inc', next });
      for (let zero = 0; zero <= 2; zero++) instructions.push({ counter, kind: 'dec', next, zero });
    }
  }
  let checked = 0;
  for (const first of instructions)
    for (const second of instructions) {
      const program = [first, second];
      for (const a of [0n, 2n])
        for (const b of [0n, 2n]) {
          const registers = { a, b };
          let pc = 1;
          for (let step = 0; pc !== 0 && step < 30; step++) {
            const op = program[pc - 1]!;
            if (op.kind === 'inc') {
              registers[op.counter]++;
              pc = op.next;
            } else if (registers[op.counter] === 0n) pc = op.zero;
            else {
              registers[op.counter]--;
              pc = op.next;
            }
          }
          if (pc !== 0) continue;
          expect(run(translate(program, a, b)).value).toBe(`${registers.a},${registers.b}`);
          checked++;
        }
    }
  expect(checked).toBeGreaterThan(500);
});
