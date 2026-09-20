# Standalone Sing

Run Sing without Discord or a context fixture:

```sh
pnpm run sing examples/counter.sing
# 9007199254741004 (after pnpm's build output)
```

The script returns an exact integer. A smaller standalone program is:

```text
LET total = 0
LET remaining = 10
WHILE remaining > 0 DO
  total = total + remaining
  remaining = remaining - 1
END
RETURN total
```

Save it as a `.sing` file and pass its path to the CLI. `RETURN` accepts an integer, decimal,
string, boolean, or null. It ends execution even inside a loop. Standalone programs do not
have access to Discord audiences, records, or `PING`.

Build once when piping output to another program:

```sh
pnpm run build
node dist/sing-cli.js examples/counter.sing
node dist/sing-cli.js --json examples/counter.sing
node dist/sing-cli.js --help
```

The CLI writes the result and a newline to stdout. `--json` writes a typed envelope, with exact
integers encoded as decimal strings so a JSON consumer cannot silently round them:

```json
{ "type": "integer", "value": "9007199254741004" }
```

Other type tags are `decimal`, `string`, `boolean`, and `null`; these use ordinary JSON values.
Plain output prints strings without quotes and booleans/null in lowercase. Diagnostics go to
stderr with exit code 1; successful runs/help use exit code 0. The CLI accepts one file, with
an optional leading `--json`. It checks source size and UTF-8 validity before worker execution.
It does not load `.env`, require a bot token, or send messages.

The runtime has the same worker timeout, heap, work, nesting, and string limits as the bot, plus
an integer digit limit. [The specification](sing-spec.md) explains why the abstract core is
Turing complete while a particular CLI run remains bounded.

## Embedding from TypeScript

The core has no Node or Discord imports. It evaluates synchronously with explicit limits:

```ts
import { execute } from './dist/sing/index.js';
import { limits } from './dist/selection.js';

const result = execute('RETURN 9007199254740992 + 1', { limits });
// { kind: 'return', value: 9007199254740993n }
```

The repository's shared `limits` object supplies the required fields; external embedders can
instead supply an `ExecutionLimits` object. The direct API is intended for trusted embedding
and conformance tests. For untrusted source, use the isolated runner:

```ts
import { runSing } from './dist/sing-runner.js';

const result = await runSing('RETURN 9007199254740992 + 1');
```

Both APIs return tagged results and preserve `bigint`; ordinary `JSON.stringify(result)` cannot
serialize an integer result. Convert integers to strings explicitly, as the CLI does.

For Discord selection scripts, keep using the existing adapter or fixture preview:

```sh
pnpm run preview examples/class.sing examples/context.json sing
```

That mode requires a `PING` result, independently validates it, and previews the plan. `RETURN`
is for standalone computations, not an alternative way to bypass selection validation.
