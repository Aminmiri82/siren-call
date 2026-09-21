# Siren Call

Siren Call is a Discord bot for pinging people with arithmetic. Instead of picking a role and
hoping for the best, you write a tiny script that says exactly who should get pinged (`@Teachers`
minus `@John Doe`, everyone who joined before Thursday, whoever's been talking in this channel),
preview the result, and send.

It's built so you can plug in any language or interface you want. Out of the box it can do
**Sing** and **Lua**, with Sing as the default.

Sing is a custom language made for pinging. It's Turing complete, has a bootstrapped compiler, and was fully vibecoded by yours truly.

```text
PING @Teachers - @John Doe SAYING "Class is cancelled"
```

## How it works

1. Run `/ping`. A Sing editor opens. Want Lua? `/ping language:Lua`. Got a one-liner?
   `/ping script:...`.
2. Your script runs in a sandbox and comes back with a set of people and a message.
3. You get a private preview: who'd be pinged, and whether you're actually allowed to ping them.
4. Hit **Send**. The bot mentions exactly those people and nobody else.

Nothing goes out until you press Send. Previews expire after five minutes.

## Sing

```text
LET audience = (@Teachers OR @Café crew) - @John Doe

IF COUNT(audience) > 0 THEN
  PING audience SAYING "Class is cancelled"
ELSE
  PING NONE SAYING "Nobody to notify"
END
```

- `@Name` is a member or a role. Spaces and accents are fine, case doesn't matter, and the
  longest match wins (`@John Doe` won't grab `@John`). Quote anything weird:
  `@"Teachers + Staff"`.
- `@everyone` is everyone who can see the channel. `@here` is whoever's online or on Do Not
  Disturb. `CALLER` is you.
- `+` / `OR`, `-`, `AND`, `XOR`, and `NOT` do what you'd expect on sets.
- `LET`, `IF`, `FOR`, `WHILE`, `FUNC`, lists, records, optional runtime types, and exact
  arbitrary-precision integers.
- `MEMBERS` is everyone in the channel, `MESSAGES` is the last ten messages. Loop over them.
- Keywords are case-insensitive. `ping @teachers saying "hi"` works.

Errors point at the exact spot and suggest fixes:

```text
Line 1, column 6: Unknown recipient “Teahcers” in this channel.

PING @Teahcers SAYING "Hello"
     ^^^^^^^^^

Did you mean @"Teachers"?
```

Read more: [language guide](docs/sing.md) · [spec](docs/sing-spec.md) ·
[CLI and embedding](docs/sing-cli.md) · [the compiler](docs/sing-compiler.md).

### Sing without Discord

Sing is a real language, so it runs on its own too:

```sh
pnpm run sing examples/counter.sing               # 9007199254741004, exactly
pnpm run sing examples/functions.sing             # closures, records, TYPE aliases
pnpm run sing:compile examples/functions.sing --run
pnpm run sing:bootstrap
```

`sing:compile` runs the [compiler](compiler/compiler.sing), which is written in Sing and emits
JavaScript. `sing:bootstrap` uses that compiler to compile itself three generations deep and
checks the outputs are identical.

## Lua

```lua
return {
  recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"),
  message = "Class is cancelled"
}
```

Bare names resolve to roles and members, so that's also `everyone() - (L1 + L2) - ...`.
`caller` is you. See [`examples/`](examples/) for more.

## Adding a language

A language is one interface:

```ts
interface SelectionLanguage {
  readonly id: string;
  compile(source: string, context: CompileContext): Promise<PingPlan>;
}
```

`context` is a plain snapshot of the channel (members, roles, recent messages). `PingPlan` is
recipient IDs plus a message. Implement it under `src/languages/<id>/`, register it in
`src/languages/index.ts`, add it to the `/ping` language option, and you're done. The host
re-validates whatever you return, so an adapter can't hand back people who aren't in the
channel. Adapters never touch Discord objects or the bot token. `AGENTS.md` has the full
checklist.

## Running it

You need Node.js 24.17+, pnpm 10.33 (`corepack enable` if you don't have it), and a Discord
application from the [Developer Portal](https://discord.com/developers/applications).

```sh
pnpm install --frozen-lockfile
cp .env.example .env     # then fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID
pnpm run register        # registers /ping in that one guild
pnpm run dev             # build + start
```

In your application's **Bot** tab, turn on:

- **Server Members Intent**: required, it's how the bot knows who's in the channel.
- **Presence Intent**: for `@here`.
- **Message Content Intent**: if you want scripts to see the text of recent messages. Without it
  they still see who posted, just with empty content.

Invite it with `bot` and `applications.commands` scopes and permissions `19456` (View Channels,
Send Messages, Embed Links). It doesn't need Administrator, Manage Roles, or Mention Everyone:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=19456
```

The bot uses a Gateway connection, so there's no web server, interactions endpoint, or public
key to set up. Keep the process running; `pnpm start` runs the built output. Commands are
registered per-guild and only `/ping` is touched, so it plays nice with other bots.

## The rules

**Who can ping whom.** The bot checks your real channel permissions (overwrites included) and its
own. If your selection covers everyone who can see the channel, you need **Mention Everyone**,
no matter how you spelled the selection. Anything smaller is allowed. This is a
full-audience rule, not anti-spam; everyone-minus-one still goes through.

**What gets sent.** Individual user mentions, batched at 2,000 characters / 100 mentions per
message, with the message text repeated in each batch. Typing `@everyone` or a role in the
message text doesn't expand the recipient list. If a batch fails, the bot tells you how far it
got and doesn't retry.

**Previews.** One use, by the person who made it, in the channel it was made in, within five
minutes. Sending rechecks permissions and drops anyone who left or lost access in the meantime;
it never adds people. A new preview replaces your old one. Restarting the bot expires all of
them.

**Context.** Scripts get the last ten messages in the channel (author, content, timestamp, bot
flag). That's the same history anyone who can run `/ping` there can already scroll. Message
content never affects who's eligible.

**Sandboxing.** Scripts are untrusted. Each one runs in a fresh worker with an empty environment
(no token, no filesystem, no network), a kill timer, and a heap cap. Lua gets a stripped
environment with no `io`, `os`, `require`, `debug`, or `load`; its only host callback turns a
name into an ID. Sing interprets a closed syntax tree and never evaluates JavaScript. Limits are
in `src/selection.ts`:

| Limit       | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Source      | 16,000 bytes (Discord caps the editor at 4,000 characters)    |
| Execution   | 2 s, then the worker is killed; 10 s startup                  |
| Memory      | 64 MiB worker heap; 16 MiB Lua allocations                    |
| Sing work   | 1,000,000 units, 100 nesting levels, 16,000 elements per list |
| Output      | 5,000 recipients, message of 1–1,500 characters               |
| Concurrency | 4 scripts at a time, 1 per person                             |

Workers are a resource boundary, not an OS sandbox. If you're going to run this for strangers,
put it in a container.

Supported: text and announcement channels. Not supported: threads, voice chat, DMs, saved
scripts.

## Development

```sh
pnpm run check      # lint, format, typecheck, tests
pnpm test
pnpm run preview examples/class.sing examples/context.json
pnpm run preview examples/class.lua examples/context.json lua
```

Tests run against `dist/` because the Lua worker resolves its runtime relative to compiled
output; Vitest builds first, so a bare `vitest` is fine. CI runs `pnpm run check` with no bot
token. For a live smoke test, run `/ping` in your server with the default script, check the
preview, send, and confirm it only mentions you.

## License

[MIT](LICENSE)
