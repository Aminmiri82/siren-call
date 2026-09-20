# Sing

Sing selects Discord ping recipients using names from the channel's eligible member snapshot
and server roles. Its adapter ID is `sing`; its file extension is `.sing`.

For programs without Discord, see the [standalone CLI guide](sing-cli.md). The
[language specification](sing-spec.md) defines grammar, numeric types, execution semantics,
compatibility changes, and the abstract core's Turing-completeness argument.

```text
PING @Teachers - @John Doe SAYING "Class is cancelled"
```

Choose `/ping language:Sing`, or run a local fixture:

```sh
pnpm run preview examples/class.sing examples/context.json sing
```

The result is one recipient set and one message. The bot still validates it, checks permissions,
shows a private preview, and waits for Send ping. Sing never sends messages during evaluation.
Lua remains the default language. Existing installations must run `pnpm run register` to expose
the new language choice in Discord.

## Names

`@everyone` selects every eligible member. `EVERYONE` is not a keyword or built-in;
without `@`, it is an ordinary variable name. This special reference uses lowercase spelling
and takes priority over server names. Use `@"everyone"` or `@"everyone else"` for literal
names that collide with it. `@everyonex` remains an ordinary name. The same quoting rule applies to `@here`.

`@` begins a member or role name. Spaces, accents, emoji, usernames, and global display names are
supported. A member selects one person; a role selects its eligible members. Matching ignores
case and accents, including Unicode combining marks, consistently with the existing member
resolver. Role matching is also case- and accent-insensitive in Sing.

The lexer takes the longest known name ending at a complete name boundary. With both `John`
and `John Doe` in the snapshot, `@John Doe` selects the latter. `@Johnathan` does not match `John`.

Operators, parentheses, commas, semicolons, quotes, `@`, `#`, newlines, and reserved
words (in any capitalization) end an unquoted name. Names containing these need quotes:

```text
PING @"Research AND Development" SAYING "Meeting at noon"
PING @"Teachers + Staff" SAYING "Meeting at noon"
PING @"IF" SAYING "Meeting at noon"
```

Keywords are recognized in any capitalization: use `@"Teachers saying hello"` for that name.
Longest matching happens within syntax boundaries; a name cannot consume `AND` or `+` as syntax. Adding or
renaming members can change an unquoted longest match. Use `@"John"` to fix the name boundary,
and a member ID when the identity must remain stable.

Quoting prevents syntax collisions, but does not disambiguate identities. Matching two members,
two roles, or a role and a member produces an error. Use an explicit kind or stable ID:

```text
PING ROLE("Teachers") SAYING "Hello"
PING MEMBER("John Doe") SAYING "Hello"
PING MEMBER("123456789012345678") SAYING "Hello"
PING <@123456789012345678> SAYING "Hello"
PING ROLE("123456789012345679") SAYING "Hello"
PING <@&123456789012345679> SAYING "Hello"
```

`MEMBER` also accepts `<@!id>`, usernames, and names with an optional leading `@`.
`@` references always mean names: `@"123"` selects the name `123`, while
`MEMBER("123")` selects member ID `123`. Likewise, `@"@John"` preserves the leading `@`.
`ROLE` checks an exact role ID before checking names. Unknown references are errors, even if
subtracting them would leave the same set. Near-match suggestions come from the snapshot;
Sing never applies a suggestion automatically. An existing role with no eligible members is
an empty set, not an unknown role.

## Presence and `@here`

`@here` selects eligible members whose observed presence is `online` or `dnd` (Do Not Disturb).
Idle, offline, and invisible members are excluded. Bare `HERE` and `here` are ordinary variable
names, not built-ins. Use `@"here"` to select a literal name. This uses presence at preview time;
the saved preview never adds recipients who come online later. Sending still rechecks membership
and channel access, but does not reevaluate presence or the script.

Enable **Presence Intent** in the Discord Developer Portal before restarting the bot. The bot
requests `GuildPresences` and copies Gateway presence into the plain member snapshot; it still
uses REST pagination for the complete eligible member list. `@here` reports an error if presence
is unavailable. Guilds above 75,000 members are treated as unavailable because Discord may
provide incomplete initial presence data there. Cached presence is a snapshot, not a guarantee
of actual notification delivery, particularly for Do Not Disturb or invisible accounts.

Local fixture contexts using `@here` must set `presenceAvailable: true` and supply member
`presence` values (`online`, `idle`, `dnd`, `offline`, or `null`). Missing or null statuses are
excluded. Existing fixtures without presence data can still use every other selection.

## Expressions

| Expression        | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `@here`           | Active eligible members with available presence data |
| `@everyone`       | All eligible members in the snapshot                 |
| `NONE`            | Empty recipient set                                  |
| `CALLER`          | Invoking member, if eligible                         |
| `a OR b`, `a + b` | Union                                                |
| `a AND b`         | Intersection                                         |
| `a XOR b`         | Symmetric difference                                 |
| `a - b`           | Difference                                           |
| `NOT a`           | Eligible members outside `a`                         |
| `COUNT(a)`        | Size of a set or record collection                   |

Set operations deduplicate IDs. They preserve left-hand order, then append new right-hand IDs
when applicable. Complement follows snapshot order. Intermediate sets may cover the whole
snapshot; only the final plan is subject to the shared 5,000-recipient output cap.

Precedence, highest first: field access and calls; unary `NOT` and `-`; comparisons;
`AND`; `+` and `-`; `XOR`; `OR`. Binary operators of equal precedence associate left to right.
Use parentheses for mixed expressions. Write `NOT (COUNT(a) > 0)` to negate a comparison.
Comparisons are binary; write `x > 0 AND x < 10`, not `0 < x < 10`.

Whole-number literals are arbitrary-precision exact integers; decimal literals (such as `1.0`)
are finite binary64 floating-point values. Both support `+`, `-`, and comparisons within their
own kind. `COUNT` returns an integer. Mixed integer/decimal arithmetic and ordering are errors;
`1 == 1.0` is false, without implicit conversion. This differs from the previous all-floating-point
implementation. Use `(x + 1) > 2` for arithmetic comparisons: legacy comparison precedence is
higher than `+`/`-`. Strings support `+` for concatenation, equality,
and lexicographic comparisons. Ordered comparisons require two numbers or two strings.
Equality and inequality (`==`, `!=`) compare scalar values without type coercion; they do not
compare sets or records. Booleans use `TRUE`, `FALSE`, `AND`, `OR`, `XOR`, and `NOT`.
Boolean `AND` and `OR` short-circuit; set operations evaluate both sides.
Conditions require booleans: use `COUNT(a) > 0`, not a set as a condition.
`NULL` represents a missing value. `+` does not implicitly convert values to strings.

Strings use double quotes with JSON escapes (`\"`, `\\`, `\n`, `\t`, `\uXXXX`).
Actual line breaks inside a string are errors. Statements are separated by newlines or
semicolons. Expressions may span lines inside parentheses. `#` begins a comment through the
end of the line, except inside strings and quoted names.

## Variables and control flow

`ping`, `PING`, and `PiNg` are equivalent, as are `count`, `COUNT`, and `Count`.
All keywords and built-ins are case-insensitive; examples may use uppercase for readability. Variable names are case-sensitive Unicode
identifiers (letters or underscore first; then letters, combining marks, numbers, or underscore).
Keywords are reserved in every capitalization: `let`, `LET`, and `Let` cannot be variable names.
Variable and record-field spelling stays case-sensitive, and string contents are preserved.
The special audience references retain their lowercase spelling: `@everyone` and `@here`.

```text
let audience = @Teachers - @John Doe
if count(audience) > 0 then
  ping audience saying "Class is cancelled"
else
  ping none saying "Nobody to notify"
end
```

```text
LET audience = (@Teachers OR @Café crew) - @John Doe

IF COUNT(audience) > 0 THEN
  PING audience SAYING "Class is cancelled"
ELSE
  PING NONE SAYING "Nobody to notify"
END
```

`LET` declares a variable in the current scope. Assign with `name = expression` after declaration.
A repeated declaration in the same scope is an error. Branches and loop iterations create local
scopes; assignment updates the nearest enclosing declaration. A local declaration may shadow
an outer variable. Variables do not have fixed types, but operations check operand types.

```text
LET audience = NONE
FOR person IN @Teachers DO
  IF person.joinedAt != NULL THEN
    audience = audience + MEMBER(person.id)
  END
END

LET remaining = 2
WHILE remaining > 0 DO
  remaining = remaining - 1
END

PING audience SAYING "Staff meeting"
```

`FOR` accepts a recipient set, `MEMBERS`, or `MESSAGES`. Iterating a set yields member records
in set order. Its collection is evaluated once; assigning a different set during the loop does
not change that iteration. `WHILE` reevaluates its boolean condition each time. Both require
`DO … END`. There are no user-defined functions, recursion, `BREAK`, or `CONTINUE`.

The first executed `PING` ends evaluation and returns its plan, including from inside a loop
or branch. The complete source must still parse. Reaching the end without executing `PING`
is an error. `RETURN` is reserved for standalone scalar results and cannot replace `PING` in a
Discord selection script. Variables formerly named `return` must be renamed, and recipient names
containing that reserved word must be quoted. An empty selection yields a preview that cannot be sent, just as with Lua.

## Context and built-ins

`MEMBERS` contains eligible member records: `id`, `name`, `username`, `globalName`, and
`joinedAt`, and optional `presence`. Missing optional fields can be absent; `globalName` and `joinedAt` may be `NULL`.
`roleIds` exists in the underlying snapshot but is deliberately not exposed as a Sing value;
use `ROLE(...)` and set operations for membership checks. Accessing an absent or unknown field
is an error. There is no host prototype or method access.

`MESSAGES` contains the recent message records supplied by the bot, oldest first:
`id`, `authorId`, `authorName`, `bot`, `content`, `createdAt`. The history may be empty and
content may be unavailable. Authors are not necessarily eligible recipients; `MEMBER` rejects
ineligible authors. Use iteration over `MEMBERS` when filtering history to eligible people.

```text
LET audience = NONE
FOR person IN MEMBERS DO
  FOR message IN MESSAGES DO
    IF message.authorId == person.id AND NOT message.bot THEN
      audience = audience + MEMBER(person.id)
    END
  END
END
PING audience SAYING "Following up"
```

| Built-in                     | Result                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `MEMBER(reference)`          | One eligible member, or an error                                             |
| `ROLE(reference)`            | Eligible holders of one role, or an error                                    |
| `COUNT(collection)`          | Count of a recipient set, `MEMBERS`, or `MESSAGES`                           |
| `JOINED_AFTER("YYYY-MM-DD")` | Members whose known join time is strictly after UTC midnight on a valid date |
| `CONTAINS(text, fragment)`   | Case-sensitive substring test                                                |
| `TEXT(value)`                | String conversion of a string, number, boolean, or `NULL`                    |

`TEXT(TRUE)`, `TEXT(FALSE)`, and `TEXT(NULL)` produce `"true"`, `"false"`, and `"null"`.
Records and collections cannot be converted with `TEXT`. Sing has no filesystem, network,
imports, environment access, arbitrary function calls, or object mutation.

## Errors and limits

Tokens and syntax nodes retain their original source spans. Diagnostics carry a code, offsets,
message, and optional suggestions. The editor error includes a one-based line and Unicode
code-point column, a bounded source excerpt, and a caret. Offsets in the programmatic diagnostic
are UTF-16 string offsets. Tabs and wide glyphs can make the visual caret approximate.

```text
Line 1, column 6: Unknown recipient “Teahcers” in this channel.

PING @Teahcers SAYING "Hello"
     ^^^^^^^^^

Did you mean @"Teachers"?
```

Source is limited to 16,000 UTF-8 bytes (Discord inputs additionally cap it at 4,000 characters).
Execution runs in a dedicated worker with an empty environment, a 10-second startup deadline,
a 2-second execution deadline, and a 64 MiB old-generation heap limit. These are not total
process memory limits. Sing also limits work to 1,000,000 units, nesting to 100 levels,
each intermediate string to 16,000 UTF-16 code units, and integer magnitudes to 16,000 decimal
digits. Exact integer operations consume work based on digit lengths. Set scans and string operations
consume work proportional to their inputs; a large snapshot may require a simpler script.
Parser depth includes blocks and expression recursion, so the accepted number of written
parentheses can be slightly below 100. All bounds live in `src/selection.ts`.

The final message must be nonblank and at most 1,500 UTF-16 code units; there can be at most
5,000 recipient IDs, all eligible. The adapter checks the plan for good diagnostics and the
host independently validates it again before permissions and preview. Worker-wide timeout or
memory failures may have no source location.
