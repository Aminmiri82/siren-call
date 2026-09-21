# Sing language specification, version 0.4

This document specifies the implemented TypeScript interpreter and its abstract computational
model. [The selection guide](sing.md) specifies the Discord host's names, records, built-ins,
and permission-independent plan construction. Version 0.4 adds scalar conversion/character/error
built-ins and explicit scalar input bindings, alongside a separate self-hosted JavaScript
compiler. The compiler implements a standalone subset; see the [compiler guide](sing-compiler.md).
The bot and reusable TypeScript core retain tree-walking interpretation.

## Profiles and architecture

The **core** evaluates expressions, declarations, assignment, branches, loops, and function calls.
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
work through the supplied service. The shipped host receives only `CompileContext` snapshots. Named calls can still dispatch to
a trusted embedding host. Host callback arguments may be scalars, recipient sets, or original
host snapshot values; user-created collections and closures are not passed into host callbacks.

## Lexical conventions

Source files are UTF-8. The CLI rejects malformed UTF-8. The core API accepts JavaScript strings.
Offsets use UTF-16 code units. Identifiers begin with a Unicode letter or `_`, followed by Unicode
letters, combining marks, numbers, or `_`. Variables and record fields are case-sensitive.
Keywords and built-ins are ASCII case-insensitive and reserved in every capitalization.

```text
RETURN PING SAYING LET IF THEN ELSE END WHILE DO FOR IN FUNC TYPE
AND OR XOR NOT TRUE FALSE NULL NONE CALLER MEMBERS MESSAGES
COUNT MEMBER ROLE JOINED_AFTER CONTAINS TEXT APPEND LENGTH SLICE
INT CHAR_CODE CHAR ERROR
```

`@everyone` and `@here` are special lowercase references. Other `@` references name a host
entity. Strings and quoted names use double quotes with JSON escapes; literal newlines and
invalid escapes are errors. `#` starts a comment outside strings. Newlines and semicolons
separate statements; other whitespace is insignificant. Inside parentheses, list/record literals, and type arguments, separators may also occur within
expressions. The implementation accepts semicolons there as well as newlines. Braces delimit
statement blocks as an alternative to `THEN`/`DO`/`END`; a closing block brace also separates
that statement from the next one. Simple statements still require a newline or semicolon,
except immediately before a block stop or end of file.

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
block      = { separator | statement } ;
statement  = "LET", identifier, [ ":", type ], "=", expression
           | identifier, "=", expression
           | "TYPE", identifier, "=", type
           | "FUNC", identifier, "(", [ parameters ], ")", [ ":", type ], body
           | "RETURN", expression
           | "PING", expression, "SAYING", expression
           | "IF", expression, "THEN", block, [ "ELSE", block ], "END"
           | "IF", expression, braced, [ "ELSE", braced ]
           | "WHILE", expression, body
           | "FOR", identifier, "IN", expression, body
           | expression ;
body       = braced | "DO", block, "END" ;
braced     = "{", block, "}" ;
parameters = parameter, { ",", parameter }, [ "," ] ;
parameter  = identifier, [ ":", type ] ;
type       = typeName | "List", "<", type, ">"
           | "{", [ typeFields ], "}" ;
typeFields = fieldName, ":", type, { ",", fieldName, ":", type }, [ "," ] ;
expression = xor, { "OR", xor } ;
xor        = sum, { "XOR", sum } ;
sum        = conjunction, { ("+" | "-"), conjunction } ;
conjunction = comparison, { "AND", comparison } ;
comparison = unary, { ("==" | "!=" | "<" | ">" | "<=" | ">="), unary } ;
unary      = ("NOT" | "-"), unary | postfix ;
postfix    = primary, { ".", identifier | "[", expression, "]"
                     | "(", [ arguments ], ")" } ;
arguments  = expression, { ",", expression }, [ "," ] ;
primary    = integer | decimal | string | "TRUE" | "FALSE" | "NULL"
           | reference | "@everyone" | "@here" | identifier | builtinName
           | "(", expression, ")"
           | "[", [ arguments ], "]"
           | "{", [ fields ], "}" ;
fields     = fieldName, ":", expression, { ",", fieldName, ":", expression }, [ "," ] ;
fieldName  = identifier | string ;
separator  = newline | ";" ;
```

The separator rules above constrain `block`; arbitrary adjacent simple statements are not
allowed. Opening block braces follow the header on the same line. In brace-style `IF`, `ELSE`
may follow the closing brace on the same line or after separators. There is no `ELSE IF`
shorthand; nest another `IF` inside `ELSE { ... }`.

`builtinName` includes the reserved values and functions listed above. Calls accept arbitrary
callee expressions, including a function stored in a list or record. Only Sing functions and
built-ins are callable; field access never exposes JavaScript methods. References include
quoted/unquoted `@` names and Discord member/role mention syntax. New brackets, braces, and
colons delimit unquoted names; quote recipient names containing them.

All binary operators associate left to right. Precedence from highest to lowest is field access, indexing,
and calls; unary operators; comparisons; `AND`; `+`/`-`; `XOR`; `OR`.

**This is the legacy set-oriented precedence, not conventional arithmetic precedence.** Write
`(x + 1) > 2`, not `x + 1 > 2`. The latter evaluates `1 > 2` first and then fails the addition's
type check. Comparison chains have ordinary binary semantics, not mathematical chaining:
`0 < x < 10` generally fails when comparing the intermediate boolean to an integer. Write
`x > 0 AND x < 10` instead. This version preserves precedence to avoid reinterpreting saved
selection expressions.

## Values and operations

| Value kind    | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| Integer       | Signed mathematical integer; implemented using JavaScript `bigint`    |
| Decimal       | Finite IEEE-754 binary64 value; implemented using JavaScript `number` |
| String        | Sequence of UTF-16 code units                                         |
| Boolean       | `TRUE` or `FALSE`                                                     |
| Null          | `NULL`                                                                |
| Recipient set | Ordered, duplicate-free collection of host member IDs                 |
| List          | Immutable ordered sequence of values                                  |
| Record        | Immutable mapping of string field names to values                     |
| Function      | Sing code with a captured lexical environment, or a built-in          |

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
- `NONE` is the empty set. `COUNT` accepts a set or list (including host record collections). `CONTAINS` accepts
  two strings and performs case-sensitive substring matching.

### Immutable collections and strings

`[1, 2]` constructs a list; `{kind: "integer", value: 42}` constructs a record. Lists and
records may contain any Sing values, including nested collections and functions. Duplicate
record fields are errors. Fields may be quoted, including names that are keywords. Access them
with `record.field` or `record["field"]`; dot access requires a non-keyword identifier. Missing
fields are errors. Inherited JavaScript properties are never available.

List indexes are zero-based exact integers, with no coercion or negative-index convention.
Out-of-bounds indexes are errors. `APPEND(list, value)` returns a new list; it does not modify
its input. Collection field/index assignment is an error, and there are no mutation methods.
Assignment to a variable only changes that binding. Equality and `TEXT` reject all composite
values, including functions. Collections retain their elements by reference; a stored closure
can still observe changes to its captured bindings.

Host record collections become lists of immutable records. Only own scalar snapshot fields
are exposed; `roleIds` remains inaccessible, including through dynamic indexing or annotations.
Lists or records that resemble members never become recipient sets.

`LENGTH(string)` returns its exact integer UTF-16 length. String indexing returns one UTF-16
code unit. `SLICE(string, start, end)` returns the half-open range, with exact integer bounds
satisfying `0 <= start <= end <= LENGTH(string)`. Invalid types or bounds are errors. These
operations use UTF-16 offsets like the parser, so indexing can split a surrogate pair.

`INT(string)` parses signed decimal digits exactly, with optional `+`/`-`, leading zeros,
and no whitespace or decimal point. It does not coerce numbers or other values. Invalid text
raises `number`; results retain the integer magnitude limit. `CHAR_CODE(string)` requires
exactly one UTF-16 code unit and returns its exact integer code. `CHAR(integer)` accepts
0 through 65535 inclusive and returns that code unit, including an individual surrogate.
Invalid character ranges/lengths raise `character`; wrong kinds raise `type`.

`ERROR(string)` stops execution with `user-error`, the supplied message, and the call's source
span. All four built-ins require exactly one argument and remain bounded. They are available
in both interpreter profiles and generated standalone programs.

### Runtime annotations and aliases

Annotations are optional on `LET`, function parameters, and function results:

```text
TYPE Token = {kind: String, value: Int};
FUNC make(value: Int): Token {
  RETURN {kind: "integer", value: value};
}
LET tokens: List<Token> = [make(42)];
RETURN tokens[0].value;
```

Supported types are `Int`, `Decimal`, `String`, `Bool`, `Null`, `List<T>`, structural record
shapes, and aliases. Type names and aliases are case-sensitive, except `Int` and `Null` follow the
case-insensitive `INT` and `NULL` keywords. Record shapes require their declared fields and
permit extras. List checks inspect every element. No numeric coercion occurs.

An annotated binding checks its initializer and every assignment, even assignment from an
inner function. Parameters are checked at each call and retain their annotation on reassignment.
Result annotations check explicit returns and implicit `NULL` fallthrough. An unannotated
binding may change kinds. Checks happen during execution; an uncalled function can contain
mismatched return expressions without error. The entire source still must parse.

`TYPE` declares a scoped alias in a separate namespace from values. Its right side resolves
when the declaration executes. Annotations resolve when their variable/function declaration
executes and retain that meaning even if a later scope shadows an alias. Aliases must be
available before use. Forward and recursive aliases, unions, optional fields, user-defined
generics, and function-type annotations are not supported. Primitive names and `List` cannot
be redefined as aliases; duplicate aliases in one scope are errors. Inner scopes may shadow
other aliases.

## Execution semantics

The entire source parses before execution, including unreachable branches. Evaluation is
left-to-right, including call arguments, except for the specified boolean short-circuiting.
Unknown names, bad operands, and other runtime errors are checked only on executed paths.

`LET` evaluates its initializer and declares in the current scope. Redeclaration in that scope
is an error. A declaration may shadow an outer variable; its initializer can still refer to
that outer variable. Assignment updates the nearest existing declaration or fails if absent.
Variables may change value kind. Every branch and every loop iteration has a fresh child scope. Annotated bindings retain
their declared constraint on assignment; unannotated bindings remain dynamic.

`IF` and `WHILE` require boolean conditions. `WHILE` reevaluates the condition before every
iteration. `FOR` evaluates its collection once, iterates list values or host records in collection order, and
binds the loop variable in each iteration's child scope. Assigning a different collection
during iteration does not affect that traversal. There is no `BREAK` or `CONTINUE`.

`FUNC name(parameters) { ... }` declares a first-class function when executed. `FUNC ... DO
... END` is also accepted. Functions share the value namespace with variables, and cannot
redeclare a name in the same scope. Parameters must have unique, non-keyword names. Functions
can be passed, stored, and returned. There are no anonymous function literals, defaults, or
variadic parameters. Calls evaluate the callee and arguments left to right and require exact
arity. Standalone expression statements evaluate and discard their result.

Functions capture their defining scope, not the caller's scope. Calls create a child of that
captured scope and bind their parameters. Captured bindings remain alive after the declaring
call returns and observe subsequent assignments. Each factory call has its own bindings.
Declarations are not hoisted: calling a function before its declaration executes is an error.
Because environments hold bindings, later declarations in the captured scope are visible to
later calls as well. Self-recursion and mutual recursion work once the necessary declarations
have executed.

`RETURN expression` exits the innermost function, propagating through its nested branches and
loops. Inside a function it may return any value; falling off the end returns `NULL`. At top
level it ends the program and still requires a scalar, preserving the worker and CLI result
contract `{ kind: 'return', value }` (including exact JavaScript `bigint`).

`PING` ends the whole program after host validation, including from inside a function used in
an expression. It bypasses pending function result checks and further expression evaluation;
its result is `{ kind: 'ping', value: { recipients, message } }`. Reaching the top-level end
without `RETURN` or `PING` is an error. The Discord adapter requires a ping result; top-level
scalar returns are rejected. Functions may use `RETURN` normally in Discord scripts. The
standalone CLI has no ping host. Neither evaluation mode sends Discord messages.

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

| Resource                                 | Limit                                 |
| ---------------------------------------- | ------------------------------------- |
| Source                                   | 16,000 UTF-8 bytes                    |
| Evaluation work                          | 1,000,000 units                       |
| Parser/execution/type/collection nesting | 100 levels each                       |
| List elements / record fields            | 16,000 per collection                 |
| Intermediate string                      | 16,000 UTF-16 code units              |
| Integer magnitude                        | 16,000 decimal digits, excluding sign |
| Worker startup / execution               | 10 seconds / 2 seconds                |
| Worker old-generation heap               | 64 MiB                                |

The abstract model has no fixed resource ceilings; **the shipped executable does**, and cannot
complete computations exceeding them. There is no CLI option that disables protections. Trusted
embedders pass finite positive safe-integer limits explicitly to the synchronous core; doing so
does not install a worker, a timeout, or an OS sandbox. Worker heap limits are not total RSS caps.

Each evaluated AST expression and statement consumes work, and loop iterations consume work.
Calls share the same budget. Execution depth counts active blocks and expressions across
function calls, rather than resetting at each call. Collection creation/copying, host snapshot
conversion, alias resolution, and recursive annotation checks also consume work. Immutable
append copies its list, so repeated append has quadratic total cost. Collection nesting is
checked even when built incrementally in a loop. The collection-size limit also applies to
`MEMBERS` and `MESSAGES` lists. String slices charge for the output length.
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
`number`, `type`, `syntax`, `collection-limit`, `index`, `immutable`, `unknown-type`, and
`missing-result`. The selection adapter preserves `missing-ping`
for fallthrough and rejects scalar returns. Whole-worker timeout/memory errors can lack spans.

## Compatibility with version 0.3

- `INT`, `CHAR_CODE`, `CHAR`, and `ERROR` are now reserved in every capitalization.
  Rename colliding variables/functions and quote colliding recipient names.
- `Int` annotations remain valid; because `INT` is reserved, any capitalization now denotes
  the primitive integer type in annotations. It cannot name a type alias.
- Trusted core embedders may pass `globals`, a scalar-only map of explicit root bindings.
  These bindings are checked against value limits and share the root declaration namespace.
  The normal CLI and Discord runner do not supply them or expose environment variables.
- The separate compiler uses a larger finite execution profile. It does not change the
  interpreter/Discord profile above. Generated code preserves supported language behavior,
  but budget accounting and exact limit boundaries can differ; see the compiler guide.

## Compatibility with version 0.2

Existing `THEN`/`DO`/`END` scripts and legacy operator precedence remain supported. The
following changes are deliberate:

- `FUNC`, `TYPE`, `APPEND`, `LENGTH`, and `SLICE` are newly reserved in every capitalization.
  Rename colliding variables and quote colliding recipient names.
- Braces, brackets, and colons now delimit unquoted recipient names. Quote such names.
- Functions can return any value internally; the external execution result remains scalar
  or a validated ping plan.
- Host records are converted to immutable language records. Collections and annotations
  consume work; combined execution depth and collection size are now bounded explicitly.
- Trusted embedders must supply the new finite positive `singCollectionItems` limit.
- The internal call AST now has a callee expression rather than a name. The supported
  `execute` and Discord `compile` entry points keep their existing result shapes.

## Earlier version 0.2 changes

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
