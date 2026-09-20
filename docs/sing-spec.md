# Sing language specification, version 0.2

This document specifies the implemented TypeScript interpreter and its abstract computational
model. [The selection guide](sing.md) specifies the Discord host's names, records, built-ins,
and permission-independent plan construction. Version 0.2 adds exact integers, standalone
execution, and `RETURN`. It does not add user-defined functions or a code-generating compiler.

## Profiles and architecture

The **core** evaluates scalar expressions, declarations, assignment, branches, and loops.
It has no Discord client, filesystem, network, environment, imports, or JavaScript evaluation.
The **selection host** supplies audience sets, name lookup, snapshot records, and `PING` validation.
The standalone CLI supplies no selection host and requires `RETURN`.

The implementation pipeline is:

```text
UTF-8 source → lexer → syntax tree → interpreter → scalar result or selection plan
```

`src/sing/` contains the reusable parser, interpreter, types, and diagnostics, with no imports
from the bot or Node APIs. `src/languages/sing/runtime.ts` implements the selection host.
`src/sing-runner.ts` and `src/sing-worker.ts` provide bounded, isolated execution for both the
CLI and Discord. All shipped execution limits remain centralized in `src/selection.ts`.

The synchronous core API is for trusted embedding code; its work limits do not substitute for
the worker's wall-clock and heap controls when evaluating hostile input. Host callbacks are
trusted implementation code, never script values. They must return plain data and account for
work through the supplied service. The shipped host receives only `CompileContext` snapshots.

## Lexical conventions

Source files are UTF-8. The CLI rejects malformed UTF-8. The core API accepts JavaScript strings.
Offsets use UTF-16 code units. Identifiers begin with a Unicode letter or `_`, followed by Unicode
letters, combining marks, numbers, or `_`. Variables and record fields are case-sensitive.
Keywords and built-ins are ASCII case-insensitive and reserved in every capitalization.

```text
RETURN PING SAYING LET IF THEN ELSE END WHILE DO FOR IN
AND OR XOR NOT TRUE FALSE NULL NONE CALLER MEMBERS MESSAGES
COUNT MEMBER ROLE JOINED_AFTER CONTAINS TEXT
```

`@everyone` and `@here` are special lowercase references. Other `@` references name a host
entity. Strings and quoted names use double quotes with JSON escapes; literal newlines and
invalid escapes are errors. `#` starts a comment outside strings. Newlines and semicolons
separate statements; other whitespace is insignificant. Inside parentheses, separators may
also occur within expressions. The implementation accepts semicolons there as well as newlines.

An integer token is one or more ASCII digits; a decimal token adds `.` and at least one digit.
Leading zeros are permitted. Signs are unary operators. There are no exponent, hexadecimal,
`NaN`, or infinity literals.

### Name parsing compatibility

Quoted references (`@"John Doe"`) have explicit boundaries. Unquoted references retain the
selection language's longest-known-name behavior. Operators, reserved words, and the other
boundaries documented in [the guide](sing.md#names) delimit candidate text; the selection host
can shorten it to the longest known name ending at a whitespace boundary.

Consequently, **selection parsing is environment-dependent**. It requires the same snapshot for
reproducibility; quoted names or IDs are preferred for saved scripts and tooling. Core programs
without selection references parse independently of any server. Changing this legacy rule is a
future language-version decision, not an implicit part of core extraction.

## Grammar

The following EBNF describes structural syntax. `block` consumes statement separators; adjacent
statements otherwise require a newline or semicolon, except immediately before a block stop or
end of file. The lexer conventions above specify tokens and contextual name boundaries.

```ebnf
program    = block, EOF ;
block      = { separator }, [ statement, { separator, { separator }, statement } ],
             { separator } ;
statement  = "LET", identifier, "=", expression
           | identifier, "=", expression
           | "RETURN", expression
           | "PING", expression, "SAYING", expression
           | "IF", expression, "THEN", block, [ "ELSE", block ], "END"
           | "WHILE", expression, "DO", block, "END"
           | "FOR", identifier, "IN", expression, "DO", block, "END" ;
expression = xor, { "OR", xor } ;
xor        = sum, { "XOR", sum } ;
sum        = conjunction, { ("+" | "-"), conjunction } ;
conjunction = comparison, { "AND", comparison } ;
comparison = unary, { ("==" | "!=" | "<" | ">" | "<=" | ">="), unary } ;
unary      = ("NOT" | "-"), unary | postfix ;
postfix    = primary, { ".", identifier } ;
primary    = integer | decimal | string | "TRUE" | "FALSE" | "NULL"
           | reference | "@everyone" | "@here"
           | callableName, [ "(", [ expression, { ",", expression } ], ")" ]
           | "(", expression, ")" ;
separator  = newline | ";" ;
```

`callableName` is an identifier or one of `NONE`, `CALLER`, `MEMBERS`, `MESSAGES`, `COUNT`,
`MEMBER`, `ROLE`, `JOINED_AFTER`, `CONTAINS`, `TEXT`. Syntactic call acceptance does not make a
name callable: the interpreter checks its built-in dispatch table and host. No arbitrary
expression or record field can be called. References include quoted/unquoted `@` names and
Discord member/role mention syntax.

All binary operators associate left to right. Precedence from highest to lowest is field access
and calls; unary operators; comparisons; `AND`; `+`/`-`; `XOR`; `OR`.

**This is the legacy set-oriented precedence, not conventional arithmetic precedence.** Write
`(x + 1) > 2`, not `x + 1 > 2`. The latter evaluates `1 > 2` first and then fails the addition's
type check. Comparison chains have ordinary binary semantics, not mathematical chaining:
`0 < x < 10` generally fails when comparing the intermediate boolean to an integer. Write
`x > 0 AND x < 10` instead. This version preserves precedence to avoid reinterpreting saved
selection expressions.

## Values and operations

| Value kind                 | Meaning                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| Integer                    | Signed mathematical integer; implemented using JavaScript `bigint`    |
| Decimal                    | Finite IEEE-754 binary64 value; implemented using JavaScript `number` |
| String                     | Sequence of UTF-16 code units                                         |
| Boolean                    | `TRUE` or `FALSE`                                                     |
| Null                       | `NULL`                                                                |
| Recipient set              | Ordered, duplicate-free collection of host member IDs                 |
| Record / record collection | Read-only host snapshot data                                          |

Integer tokens create integers exactly, without an intermediate floating-point conversion.
Decimal tokens create binary64 values: their arithmetic may round. `COUNT` returns an integer.
No implicit conversion occurs between integers, decimals, booleans, strings, and sets.

- Unary `-` accepts either numeric kind. Binary `+`/`-` accept two integers or two decimals of
  the same kind. Integer results are exact. Non-finite decimal literals/results are errors.
- `+` concatenates two strings. `TEXT` explicitly converts a scalar to a string: integers use
  base-10 digits without an `n` suffix; booleans and null use lowercase spelling; decimals use
  JavaScript's number-to-string representation. It rejects records and collections.
- Equality/inequality accept scalars and compare without coercion. `1 == 1.0` is false.
  Decimal positive and negative zero compare equal. Composite equality is an error.
- Ordered comparisons require two integers, two decimals, or two strings. Strings compare
  lexicographically by UTF-16 code units. Mixed integer/decimal ordering is an error.
- Boolean `AND`/`OR` short-circuit after a false/true left operand, respectively; the right
  expression is then neither evaluated nor type-checked. Otherwise both operands must be
  compatible. Boolean `XOR` is inequality and `NOT` is negation.
- Sets support union (`+`, `OR`), difference (`-`), intersection (`AND`), symmetric difference
  (`XOR`), and host-relative complement (`NOT`). Both operands of binary set operations are
  evaluated. Results retain left-side order, appending qualifying new right-side IDs.
- `NONE` is the empty set. `COUNT` accepts a set or host record collection. `CONTAINS` accepts
  two strings and performs case-sensitive substring matching.

The core has no user-created lists, records, functions, or mutable objects. A record permits
only access to an own scalar field. Missing fields, inherited properties, and array-valued
fields are errors; the selection host's `roleIds` therefore remains inaccessible as a value.

## Execution semantics

The entire source parses before execution, including unreachable branches. Evaluation is
left-to-right, including call arguments, except for the specified boolean short-circuiting.
Unknown names, bad operands, and other runtime errors are checked only on executed paths.

`LET` evaluates its initializer and declares in the current scope. Redeclaration in that scope
is an error. A declaration may shadow an outer variable; its initializer can still refer to
that outer variable. Assignment updates the nearest existing declaration or fails if absent.
Variables may change value kind. Every branch and every loop iteration has a fresh child scope.

`IF` and `WHILE` require boolean conditions. `WHILE` reevaluates the condition before every
iteration. `FOR` evaluates its collection once, iterates host records in collection order, and
binds the loop variable in each iteration's child scope. Assigning a different collection
during iteration does not affect that traversal. There is no `BREAK`, `CONTINUE`, or recursion.

`RETURN expression` requires a scalar and immediately ends the whole program, even inside a
branch or loop. The core returns `{ kind: 'return', value }`, preserving JavaScript `bigint`.
`PING` immediately returns `{ kind: 'ping', value: { recipients, message } }` after host
validation. Reaching the end without either result is an error. The Discord adapter requires
a ping result; executing `RETURN` there is an error. The standalone CLI has no ping host.
Neither evaluation mode sends Discord messages.

## Turing completeness

The **abstract integer core is Turing complete** when source size, integer magnitude, and
execution work are not given fixed bounds. This statement concerns expressive power, not the
claim that a finite computer can supply infinite memory.

A two-counter machine has nonnegative integer registers `a`, `b`, a finite instruction table,
and a program counter `pc`. Its instructions increment a register and jump, or test a register
for zero and otherwise decrement it before jumping. Such machines are universal; see the
[two-counter machine construction in Richard (2009)](https://richardg.users.greyc.fr/publis/Richard_2009.pdf).

Translate its finite table into one outer Sing `WHILE pc != 0 DO ... END`. Inside each iteration:

1. Declare `LET instruction = pc` to freeze dispatch.
2. For each instruction label `k`, emit `IF instruction == k THEN ... END`.
3. Translate increment as `a = a + 1; pc = next` (or use `b`).
4. Translate conditional decrement as
   `IF a == 0 THEN pc = zero ELSE a = a - 1; pc = next END`.
5. Use label `0` for halt; after the loop, `RETURN a` (or another scalar encoding of output).

The invariant at the start of each outer iteration is that Sing's `a`, `b`, and `pc` equal the
machine configuration. Exactly one instruction block executes because it compares the frozen
label, even if that instruction changes `pc`. Its arithmetic and branches implement the machine
transition exactly, preserve nonnegative registers, and establish the invariant for the next
iteration. `pc = 0` exits both computations; a nonhalting machine continues taking transitions
in the abstract semantics. Every finite machine translates to a finite program with constant
syntactic nesting depth. Thus Sing simulates every two-counter machine and inherits universality.

[The runnable counter example](../examples/counter.sing) transfers one register into another
beyond binary64's exact-integer range. `tests/sing-core.test.ts` compares translations against
an independent simulator over small machines that halt within a test horizon. Those tests check
the translation and implementation; the invariant argument, not finite testing, establishes
the abstract universality claim.

## Bounded execution and diagnostics

The shipped CLI and bot deliberately implement a bounded execution profile:

| Resource                   | Limit                                 |
| -------------------------- | ------------------------------------- |
| Source                     | 16,000 UTF-8 bytes                    |
| Evaluation work            | 1,000,000 units                       |
| Parser/evaluator nesting   | 100 levels                            |
| Intermediate string        | 16,000 UTF-16 code units              |
| Integer magnitude          | 16,000 decimal digits, excluding sign |
| Worker startup / execution | 10 seconds / 2 seconds                |
| Worker old-generation heap | 64 MiB                                |

The abstract model has no fixed resource ceilings; **the shipped executable does**, and cannot
complete computations exceeding them. There is no CLI option that disables protections. Trusted
embedders pass finite positive safe-integer limits explicitly to the synchronous core; doing so
does not install a worker, a timeout, or an OS sandbox. Worker heap limits are not total RSS caps.

Each evaluated AST expression and statement consumes work, and loop iterations consume work.
Set operations charge for input sizes. String concatenation, substring search, and scalar string comparisons charge for
input lengths; `TEXT` also charges for string input length. Integer literals/results charge for their decimal digit lengths; arithmetic and
comparisons additionally charge for integer operand lengths; negation and `TEXT` also charge
for the integer input. These are implementation work units, not a guarantee of exact CPU cost
or a portable instruction counter. The worker deadline also bounds parsing and host lookup.
Large-integer conversion itself takes work, so source/magnitude caps and worker limits remain
necessary even with accounting. Limits reject excessive programs rather than changing integer
values or silently truncating arithmetic.

Errors use `SingError` with a code, start/end UTF-16 offsets, message, and optional suggestions.
The formatted message has a one-based line and Unicode-code-point column and a bounded excerpt.
Core errors include `source-limit`, `step-limit`, `depth-limit`, `integer-limit`, `string-limit`,
`number`, `type`, `syntax`, and `missing-result`. The selection adapter preserves `missing-ping`
for fallthrough and rejects scalar returns. Whole-worker timeout/memory errors can lack spans.

## Compatibility with the previous implementation

Existing set syntax, ordering, scoping, name resolution, previews, and plan validation remain.
The deliberate language changes are:

- Whole-number literals and `COUNT` now produce exact integers. Integers beyond `2^53 - 1`
  no longer round. Decimal arithmetic still exists but mixing it with integers is rejected;
  `1 == 1.0` now evaluates false. Use matching literal kinds in numeric calculations.
- `RETURN` is newly reserved in every capitalization. Rename variables previously called
  `return`; quote recipient names containing that word, just as for other reserved words.
- Integer-heavy computations and scalar string comparisons consume size-based work and may hit
  a limit sooner than before. String conversion and set-to-record iteration also account for
  input size.

Direct consumers of the internal parser must use `src/sing/parser.ts` and supply a name lookup
and parser depth limit. The supported embedding entry point is `src/sing/index.ts`; the Discord
`SelectionLanguage.compile(source, context)` interface remains unchanged.
