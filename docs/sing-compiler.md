# The self-hosted Sing compiler

Sing can compile its standalone language to JavaScript. The lexer, precedence parser, and code
emitter are written in [compiler/compiler.sing](../compiler/compiler.sing). The existing
TypeScript interpreter runs that compiler to produce its first JavaScript executable. That
executable can then compile the original Sing compiler source again.

## Try it

```sh
pnpm run sing:compile examples/functions.sing --run
pnpm run sing:bootstrap
```

The first command compiles and runs a program in a bounded worker. The second checks three
compiler generations for byte-for-byte equality, checks sample programs with all three, and
writes the generated compilers to `dist/bootstrap/stage1.mjs`, `stage2.mjs`, and `stage3.mjs`.
These are generated build artifacts, not source files to edit.

To keep the generated JavaScript:

```sh
pnpm run sing:compile examples/counter.sing -o counter.mjs
node counter.mjs
```

The output path must end in `.mjs`. Compilation refuses to overwrite an existing output file.
Without `-o` or `--run`, the CLI prints JavaScript to stdout. Build once and invoke the Node
entry point directly when piping it, so pnpm/build messages do not enter the output:

```sh
pnpm run build
node dist/compiler/cli.js examples/counter.sing > counter.mjs
node dist/compiler/cli.js --help
```

Generated modules import the support runtime using an absolute file URL into this checkout's
`dist/compiler/runtime.js`. They are not bundled or independently distributable. Keep the
checkout/build in place, or regenerate after moving it. Running a module directly prints its
scalar result; importing it exposes a default `run(options)` function and prints nothing.

## What it supports

The compiler covers the standalone constructs needed to compile itself:

- Exact integers, finite decimals, strings, booleans, and null.
- Arithmetic, comparisons, boolean short circuiting, and the existing Sing precedence.
- Variables, assignment, branches, loops, and early returns.
- Lexical `FUNC` functions, recursion, escaping closures, and functions as values.
- Immutable lists/records, indexing, field access, and all standalone scalar/list built-ins.
- Optional runtime annotations and scoped, non-recursive `TYPE` aliases.
- Brace/semicolon syntax and legacy `THEN`/`DO`/`END` syntax.

Identifiers are deliberately limited to ASCII letters, digits, and underscore (not beginning
with a digit) in this first compiler. Unicode strings and quoted record keys are supported,
including JSON escapes and individual UTF-16 surrogate code units. The TypeScript interpreter
continues to support Unicode identifiers.

Discord selection syntax is unsupported, including `PING`, `@` references, `NONE`, `CALLER`,
`MEMBERS`, `MESSAGES`, `MEMBER`, `ROLE`, and `JOINED_AFTER`. Unsupported syntax is rejected even
in an unreachable branch. Use the existing interpreter for selection scripts. This compiler
does not replace the bot adapter or change preview, authorization, or delivery.

There is no optimizer, native-code backend, static type checker, module system, or source-map
file. Runtime checks and source-span diagnostics are emitted through the support runtime.
Budget accounting and exact acceptance at depth/work boundaries can differ between interpreted
and compiled execution; both are explicitly bounded.

## How compilation works

```text
Sing input
  → Sing lexer: token records with source offsets
  → Sing precedence parser: expressions and statements
  → JavaScript emitted during parsing
  → JavaScript execution with checked Sing operations
```

The parser emits code directly rather than constructing a separate full syntax tree. Expression
records carry generated code, a source span, and (for variables) a name. Calls, indexing, and
fields extend these expressions; binary precedence determines how they are composed.

Generated JavaScript uses native branches, loops, and callable bodies. The support runtime in
[src/compiler/runtime.ts](../src/compiler/runtime.ts) implements Sing values, scopes, checked
operators, annotations, and resource accounting. It does not parse source or evaluate syntax
trees, and does not invoke the TypeScript interpreter. It remains a TypeScript/JavaScript runtime
dependency, just as the output depends on Node for execution.

Names are emitted as quoted keys into Sing scopes, not native JavaScript identifiers. This
preserves Sing's lookup and late-binding rules and allows names such as `arguments` without
colliding with JavaScript syntax. Literals and record keys are escaped as data. Strings cannot
inject JavaScript, and record access cannot reveal JavaScript prototypes or methods.

A private return signal crosses compiled loop/branch blocks and is caught by the current
function call. At program level, only scalar returns can cross the worker boundary. Function
result checks still run on explicit return and implicit `NULL` fallthrough.

Compilation errors carry `compile-syntax` diagnostics with offsets in the input file. The
compiler's `ERROR` helper sends an offset envelope that the runner reconstructs as a `SingError`.
Generated runtime errors also report original Sing source offsets. Limit failures while running
the compiler itself may instead point into `compiler.sing`.

## The bootstrap check

The build produces these stages:

1. The TypeScript interpreter runs `compiler.sing` with its own source as input, producing stage 1.
2. Stage 1 compiles that same Sing source, producing stage 2.
3. Stage 2 compiles that same source, producing stage 3.

All three outputs must be identical for the same source and runtime URL. The CLI also uses each
stage to compile and run examples covering exact arithmetic, lexical closures, and annotations.
The test suite separately compares interpreted and compiled results/errors across the supported
language, tests malformed inputs, and checks worker resource boundaries.

This demonstrates self-hosting: the compiler is written in the language it compiles and can
rebuild itself. It does not claim that the support runtime, Node, or the original seed interpreter
have been replaced, and fixed-point equality alone is not proof of semantic correctness.

## Input, limits, and execution boundaries

The trusted runner reads files and supplies two scalar globals to the compiler:

- `SOURCE`: the input Sing text.
- `RUNTIME`: the URL to import for checked generated-code operations.

The compiler returns its JavaScript as a string. Sing gets no filesystem, network, environment,
JavaScript evaluation, or import built-ins. The original interpreter and bot keep their existing
execution profile. Compilation uses a separate profile centralized in `src/selection.ts`:

| Resource                                 | Compiler profile             |
| ---------------------------------------- | ---------------------------- |
| Input/seed source                        | 1,000,000 UTF-8 bytes        |
| Evaluation work                          | 10,000,000,000 units         |
| Execution/parser/type/collection nesting | 500 levels                   |
| Intermediate/output strings              | 16,000,000 UTF-16 code units |
| List elements/record fields              | 100,000                      |
| Integer magnitude                        | 16,000 decimal digits        |
| Startup / execution deadline             | 10 seconds / 60 seconds      |
| Worker old-generation heap               | 256 MiB                      |

These are ceilings, not a promise that every input below the size limit will finish. Repeated
immutable append and string concatenation can be expensive; the compiler favors clarity over
optimization. The CLI checks byte bounds and UTF-8 validity before compiling.

`--run` executes the generated target using the normal two-second, 64 MiB worker profile and
normal language limits. Compiling a large program does not automatically grant it the compiler
execution profile. Embedders can explicitly select that profile when running the compiler or
other larger standalone programs.

The toolchain's workers have empty environments, finite heap limits, and kill timers. Workers
are resource boundaries, not OS sandboxes. `runCompiled` and `compileUsing` accept trusted
generated JavaScript; do not use them as services for executing arbitrary submitted JavaScript.
Direct `node output.mjs` execution retains language work/depth/value checks but has no outer
worker deadline or heap cap; use `--run` for that bounded path.

## Embedding and using a generated compiler

```ts
import { readFile } from 'node:fs/promises';
import { compile, compileUsing, runCompiled } from './dist/compiler/index.js';

const module = await compile('RETURN 40 + 2;');
console.log(await runCompiled(module)); // 42n

// After pnpm run sing:bootstrap, this path uses the generated compiler, not the interpreter.
const compiler = await readFile('dist/bootstrap/stage3.mjs', 'utf8');
const anotherModule = await compileUsing(compiler, 'RETURN 41 + 1;');
console.log(await runCompiled(anotherModule)); // 42n
```

`compile` runs the seed compiler through the interpreter. `compileUsing` uses a previously
generated compiler with the compiler profile. `runCompiled` returns a scalar (including exact
`bigint`), whereas the existing interpreter API returns a tagged execution result. Each call
uses a fresh worker. The compiler APIs do not load `.env` or contact Discord.

The core interpreter also accepts `globals` in its trusted `ExecutionOptions`, and generated
`run` functions accept the same scalar-only binding map. Globals are explicit root bindings,
not host objects or access to process globals.
