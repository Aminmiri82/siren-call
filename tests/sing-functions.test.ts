import { describe, expect, it } from 'vitest';
import type { SelectionHost } from '../dist/sing/index.js';
import { execute, SingError } from '../dist/sing/index.js';
import { runSing } from '../dist/sing-runner.js';
import { limits } from '../dist/selection.js';
import { SingSelectionLanguage } from '../dist/languages/sing/index.js';

const run = (source: string) => execute(source, { limits }).value;

describe('Sing functions and lexical scope', () => {
  it('uses the defining environment rather than the calling environment', () => {
    expect(
      run(`
      LET offset = 10;
      FUNC adjust(value) { RETURN value + offset; }
      FUNC other() { LET offset = 100; RETURN adjust(1); }
      RETURN other();
    `),
    ).toBe(11n);
  });

  it('keeps separate captured bindings alive after the declaring call returns', () => {
    expect(
      run(`
      FUNC counter(start: Int) {
        FUNC next(): Int { start = start + 1; RETURN start; }
        RETURN next;
      }
      LET first = counter(10);
      LET second = counter(100);
      first();
      RETURN TEXT(first()) + "," + TEXT(second());
    `),
    ).toBe('12,101');
  });

  it('reads reassigned captured variables and permits local shadowing', () => {
    expect(
      run(`
      LET offset = 1;
      FUNC read() { RETURN offset; }
      offset = 5;
      IF TRUE { LET offset = 100; offset = 200; }
      RETURN read();
    `),
    ).toBe(5n);
  });

  it('returns from nested loops to the current function and allows recursive calls', () => {
    expect(
      run(`
      FUNC sum(n: Int): Int {
        IF n == 0 { RETURN 0; }
        RETURN n + sum(n - 1);
      }
      FUNC find(values: List<Int>): Int {
        FOR value IN values {
          IF value > 0 { RETURN sum(value); }
        }
        RETURN 0;
      }
      LET result = find([-1, 4, 9]);
      RETURN result + 100;
    `),
    ).toBe(110n);
  });

  it('allows functions in lists and records, higher-order calls, and NULL fallthrough', () => {
    expect(
      run(`
      FUNC increment(x) { RETURN x + 1; }
      FUNC invoke(fn, x) { RETURN fn(x); }
      FUNC empty() {}
      LET callbacks = [{apply: increment}];
      LET result = invoke(callbacks[0].apply, 4);
      RETURN (result == 5) AND (empty() == NULL);
    `),
    ).toBe(true);
  });

  it('supports legacy function blocks and mixed case keywords without hoisting', () => {
    expect(run('func add(x) do return x + 1 end; RETURN add(2)')).toBe(3n);
    expect(() => run('RETURN later(); FUNC later() { RETURN 1; }')).toThrow('Unknown function');
    expect(() => run('FUNC f(x, x) { RETURN x; } RETURN 1')).toThrow('Duplicate');
    expect(() => run('FUNC f(x) {} RETURN f()')).toThrow('expects 1');
    expect(() => run('LET f = 3; RETURN f()')).toThrow('not callable');
  });
});

describe('Sing immutable collections and braces', () => {
  it('preserves shared lists and records when appending and rebinding', () => {
    expect(
      run(`
      LET original = [{value: 10}];
      LET alias = original;
      FUNC extend(items) { RETURN APPEND(items, {value: 20}); }
      LET extended = extend(original);
      original = [{value: 99}];
      RETURN TEXT(alias[0].value) + "," + TEXT(COUNT(extended)) + "," + TEXT(original[0].value);
    `),
    ).toBe('10,2,99');
  });

  it('evaluates a FOR collection once and visits scalar and nested values in order', () => {
    expect(
      run(`
      LET values = [1, 2, 3];
      LET output = "";
      FOR item IN values {
        values = [];
        output = output + TEXT(item);
      }
      RETURN output;
    `),
    ).toBe('123');
  });

  it('supports multiline literals, trailing commas, dynamic keys, and prototype-like fields', () => {
    expect(
      run(`
      LET values = [
        {"__proto__": {constructor: "safe"},},
      ];
      LET key = "__proto__";
      RETURN values[0][key].constructor;
    `),
    ).toBe('safe');
    expect(() => run('RETURN {}.constructor')).toThrow('Unknown field');
  });

  it('keeps semicolons optional and supports new-line ELSE and nested legacy blocks', () => {
    expect(
      run(`
      LET value = 0
      WHILE value < 3 {
        IF value == 0 THEN value = value + 1 END
        IF FALSE { value = 100 }
        ELSE { value = value + 1 }
      }
      RETURN value
    `),
    ).toBe(3n);
  });

  it.each([
    ['LET x = [1]; x[0] = 2; RETURN 0', 'immutable'],
    ['LET x = {a: 1}; x.a = 2; RETURN 0', 'immutable'],
    ['RETURN [1][-1]', 'out of bounds'],
    ['RETURN [1][1]', 'out of bounds'],
    ['RETURN [1][0.0]', 'expects an Int'],
    ['RETURN [1][9007199254740993]', 'out of bounds'],
    ['RETURN {a: 1}[0]', 'Expected a string'],
    ['RETURN {a: 1}.missing', 'Unknown field'],
    ['RETURN [1] == [1]', 'Equality compares'],
    ['RETURN {a: 1, a: 2}', 'Duplicate'],
    ['RETURN [1]', 'scalar'],
    ['FUNC f() {} RETURN f', 'scalar'],
    ['IF TRUE { RETURN 1', 'Missing }'],
  ])('rejects invalid collection or block behavior: %s', (source, message) => {
    expect(() => run(source)).toThrow(message);
  });

  it('offers bounded UTF-16 string access for processing source text', () => {
    expect(run('RETURN SLICE("hello", 1, 4) + "hello"[4]')).toBe('ello');
    expect(run('RETURN LENGTH("😀")')).toBe(2n);
    expect(() => run('RETURN SLICE("hello", 0, 6)')).toThrow('out of range');
    expect(() => run('RETURN SLICE("hello", 0.0, 1)')).toThrow('expect Int');
    expect(() => run('RETURN "a"[1]')).toThrow('out of bounds');
  });
});

describe('Sing runtime annotations', () => {
  it('checks structural aliases and nested lists while permitting extra record fields', () => {
    expect(
      run(`
      TYPE Token = {kind: String, value: Int};
      TYPE Tokens = List<Token>;
      FUNC make(value: Int): Token { RETURN {kind: "integer", value: value, extra: TRUE}; }
      FUNC total(tokens: Tokens): Int {
        LET sum: Int = 0;
        FOR token IN tokens { sum = sum + token.value; }
        RETURN sum;
      }
      LET tokens: Tokens = [make(20), make(22)];
      RETURN total(tokens);
    `),
    ).toBe(42n);
  });

  it('keeps aliases lexical and annotations fixed when a different alias shadows them', () => {
    expect(
      run(`
      TYPE Item = Int;
      FUNC identity(x: Item): Item { RETURN x; }
      IF TRUE {
        TYPE Item = String;
        LET label: Item = "yes";
        RETURN identity(42);
      }
      RETURN 0;
    `),
    ).toBe(42n);
  });

  it('accepts primitive annotations and keeps unannotated variables dynamic', () => {
    expect(
      run(`
      LET i: Int = 1;
      LET d: Decimal = 1.0;
      LET b: Bool = TRUE;
      LET n: Null = NULL;
      LET s: String = "ok";
      LET dynamic = i;
      dynamic = s;
      RETURN dynamic;
    `),
    ).toBe('ok');
  });

  it.each([
    ['LET x: Int = 1.0; RETURN x', 'x expects Int'],
    ['LET x: Int = 1; x = "bad"; RETURN x', 'x expects Int'],
    ['LET x: Int = 1; FUNC bad() { x = FALSE; } bad(); RETURN x', 'x expects Int'],
    ['FUNC f(x: Int) { x = "bad"; } f(1); RETURN 0', 'x expects Int'],
    ['FUNC f(x: List<Int>) {} f([1, "bad"]); RETURN 0', 'x[1] expects Int'],
    ['FUNC f(): Int { RETURN "bad"; } RETURN f()', 'f return expects Int'],
    ['FUNC f(): Int {} RETURN f()', 'f return expects Int'],
    ['TYPE T = {a: Int}; LET x: T = {}; RETURN 0', 'missing field'],
    ['TYPE T = {a: Int}; LET x: T = {a: FALSE}; RETURN 0', 'x.a expects Int'],
    ['TYPE T = List<T>; RETURN 0', 'Unknown type'],
    ['TYPE T = Later; TYPE Later = Int; RETURN 0', 'Unknown type'],
    ['TYPE Int = String; RETURN 0', 'reserved'],
    ['LET x: Mystery = 1; RETURN 0', 'Unknown type'],
  ])('enforces annotations at the executed boundary: %s', (source, message) => {
    expect(() => run(source)).toThrow(message);
  });

  it('does not statically reject an unexecuted type mismatch', () => {
    expect(run('FUNC unused(): Int { RETURN "bad"; } RETURN 42')).toBe(42n);
  });

  it('reports a type failure with its source span across the worker', async () => {
    const source = 'LET x: Int = 1;\nx = "bad"; RETURN x';
    try {
      await runSing(source);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SingError);
      const diagnostic = (error as SingError).diagnostic;
      expect(diagnostic.code).toBe('type');
      expect(source.slice(diagnostic.start, diagnostic.end)).toBe('"bad"');
    }
  });
});

describe('Sing function and collection execution boundaries', () => {
  it('shares the work budget across calls and charges collection type checking', () => {
    expect(() =>
      execute('FUNC f() {} WHILE TRUE { f(); }', {
        limits: { ...limits, singSteps: 100 },
      }),
    ).toThrow('step limit');
    expect(() =>
      execute(
        `
      TYPE Row = List<Int>;
      LET row = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      LET rows = [row, row, row, row, row, row, row, row, row, row];
      LET checked: List<Row> = rows;
      RETURN 0;
    `,
        { limits: { ...limits, singSteps: 100 } },
      ),
    ).toThrow('step limit');
  });

  it('bounds collection size and nesting independently of syntax nesting', () => {
    expect(() =>
      execute('RETURN COUNT(APPEND([1, 2], 3))', {
        limits: { ...limits, singCollectionItems: 2 },
      }),
    ).toThrow('collection is too large');
    expect(() => run('LET x = []; WHILE TRUE { x = [x]; }')).toThrow('collection nesting');
    const aliases = Array.from(
      { length: limits.singDepth + 1 },
      (_, i) => `TYPE T${i + 1} = List<T${i}>;`,
    ).join('\n');
    expect(() => run(`TYPE T0 = Int; ${aliases} RETURN 0`)).toThrow('type nesting');
  });

  it('bounds combined block and call depth before exhausting the JavaScript stack', async () => {
    const nested = 'IF TRUE {'.repeat(60) + 'RETURN recurse();' + '}'.repeat(60);
    const source = `FUNC recurse() { ${nested} } RETURN recurse();`;
    expect(() => run(source)).toThrow(SingError);
    await expect(runSing(source)).rejects.toMatchObject({
      name: 'SingError',
      diagnostic: { code: 'depth-limit' },
    });
  });

  it('refuses runaway recursion and collection growth in workers and recovers', async () => {
    await expect(
      runSing('FUNC recurse() { RETURN recurse(); } RETURN recurse();'),
    ).rejects.toMatchObject({ name: 'SingError', diagnostic: { code: 'depth-limit' } });
    await expect(runSing('LET x = []; WHILE TRUE { x = APPEND(x, x); }')).rejects.toThrow(
      /nesting|step limit|time limit/,
    );
    await expect(runSing('FUNC f(x: Int): Int { RETURN x + 1; } RETURN f(41);')).resolves.toEqual({
      kind: 'return',
      value: 42n,
    });
  });

  it('keeps trusted host snapshot callbacks usable without handing them closures', () => {
    const record = { label: 'snapshot' };
    const host: SelectionHost = {
      names: { has: () => false },
      audience: () => new Set(),
      resolve: () => new Set(),
      variable: name => (name === 'snapshot' ? record : undefined),
      call: (name, args) => (name === 'readLabel' && args[0] === record ? record.label : undefined),
      records: () => [],
      ping: plan => plan,
    };
    expect(execute('RETURN readLabel(snapshot)', { limits, host }).value).toBe('snapshot');
    expect(() => execute('FUNC f() {} RETURN readLabel(f)', { limits, host })).toThrow(
      'cannot receive',
    );
    expect(() => execute('RETURN readLabel({label: "forged"})', { limits, host })).toThrow(
      'cannot receive',
    );
  });

  it('preserves PING termination through expression calls and validates real recipient sets', async () => {
    const adapter = new SingSelectionLanguage();
    const context = {
      callerId: '1',
      roles: [],
      messages: [],
      members: [{ id: '1', name: 'One', roleIds: [], joinedAt: null }],
    };
    await expect(
      adapter.compile(
        `
      FUNC choose() { RETURN CALLER; }
      FUNC stop() { PING choose() SAYING "hi"; }
      FUNC outer(): Int { RETURN 1 + stop(); }
      LET unused = [outer(), missing];
      PING NONE SAYING "wrong";
    `,
        context,
      ),
    ).resolves.toEqual({ recipients: ['1'], message: 'hi' });
    await expect(adapter.compile('PING [{id: "1"}] SAYING "hi"', context)).rejects.toThrow(
      'recipient set',
    );
    await expect(adapter.compile('RETURN MEMBERS[0].roleIds', context)).rejects.toThrow('roleIds');
    await expect(
      adapter.compile('MEMBERS[0].name = "changed"; PING CALLER SAYING "hi"', context),
    ).rejects.toThrow('immutable');
    await expect(
      adapter.compile(
        'FUNC f(person: {id: String}) { RETURN MEMBER(person.id); } PING f(MEMBERS[0]) SAYING "hi"',
        context,
      ),
    ).resolves.toEqual({ recipients: ['1'], message: 'hi' });
  });
});
