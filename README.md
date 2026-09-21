# Siren Call

A Discord bot for doing arithmetic on pings, using **Sing** or **Lua**.

Sing is a purpose-built language for selecting recipients by their server names:

```text
PING @Teachers - @John Doe SAYING "Class is cancelled"
```

Sing is the default language, so `/ping` opens its editor; you can also supply a short `script`
directly. The adapter ID is `sing`. Use `@everyone` for all eligible members and `@here` for active
members (online or Do Not Disturb; excludes idle/offline/invisible). Keywords and built-ins are case-insensitive; names may contain spaces and accents.
See the [Sing language reference](docs/sing.md) for operators, quoted names, variables,
control flow, built-ins, diagnostics, and limits. Lua is still available with `/ping language:Lua`:

```lua
return {
  recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"),
  message = "Class is cancelled"
}
```

A bare name that is a valid Lua identifier resolves to the role or member it names, so the script
above can also be written `everyone() - (L1 + L2) - joined_after("2026-09-18")`. `caller` is the
person who ran the command.

`/ping` opens the default Sing editor; `/ping language:Lua` opens the Lua editor. Submit a script to get a private recipient/permission preview, then choose **Send ping** or **Cancel**. You can also put short scripts directly in `/ping script:...`.

## Standalone Sing

Sing also runs without Discord. Its TypeScript core supports exact integers, lexical `FUNC` functions, immutable lists/records,
optional runtime-checked types, conditionals, loops, and scalar top-level `RETURN` values:

```sh
pnpm run sing examples/counter.sing
# Returns 9007199254741004 exactly.
```

See the [CLI and embedding guide](docs/sing-cli.md) and [language specification](docs/sing-spec.md).
The abstract integer core is Turing complete; the CLI and bot retain resource limits.
Whole-number literals and `COUNT` are exact integers; decimal literals remain floating-point.
Mixing them in arithmetic is an error. Try `pnpm run sing examples/functions.sing` for functions,
closures, immutable collections, and `TYPE` aliases. Braces and semicolons are supported alongside
legacy blocks. `FUNC`, `TYPE`, `APPEND`, `LENGTH`, and `SLICE` are newly reserved; quote colliding
recipient names. Discord scripts still finish with `PING`.

## Compile Sing with Sing

The standalone [compiler](compiler/compiler.sing) is written in Sing and emits JavaScript:

```sh
pnpm run sing:compile examples/functions.sing --run
pnpm run sing:bootstrap
```

The bootstrap check rebuilds the compiler through three identical generations and verifies
sample programs with each. Generated stages live in `dist/bootstrap/`. See the
[compiler guide](docs/sing-compiler.md) for saving modules, architecture, and limits.
This first compiler supports ASCII identifiers and standalone programs; the bot continues
using its existing interpreter. `INT`, `CHAR_CODE`, `CHAR`, and `ERROR` are now reserved
built-ins, so quote colliding recipient names and rename colliding variables.

## Run locally

Requires Node.js 24.17+, pnpm 10.33.0 (pinned in `package.json`), and a Discord bot application. If pnpm is not available, run `corepack enable` first.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Add your bot token to .env (never commit it).
pnpm run register
pnpm run dev
```

If `.env` already exists, edit it instead of copying over it. `.env` and `.env.*` are ignored, except the empty `.env.example` template.

The default application is `1550468456678170684`, and commands are registered only in test server `1422967166088773664`. Override these with `DISCORD_APPLICATION_ID` and `DISCORD_GUILD_ID`.

In the [Developer Portal](https://discord.com/developers/applications/1550468456678170684/bot), enable **Server Members Intent** and save. Enable **Message Content Intent** as well if you want scripts to read the recent-message context; without it Discord returns those messages with empty `content`, and everything else still works. Enable **Presence Intent** as well for Sing’s `@here` selection; the bot now requests it at login. This bot uses a Gateway connection, so it needs no public web server, interactions endpoint, or public-key configuration.

[Install SirenCall in the test server](https://discord.com/oauth2/authorize?client_id=1550468456678170684&scope=bot%20applications.commands&permissions=19456&guild_id=1422967166088773664&disable_guild_select=true). Requested permissions: View Channels, Send Messages, Embed Links. No Administrator, Manage Roles, or Mention Everyone permission for the bot.

The process must stay running for the bot to respond. `pnpm start` runs the built output; `pnpm run dev` rebuilds first. Command registration upserts only `/ping`, leaving other commands alone.

## Permissions and preview semantics

The bot checks the caller's effective channel permissions, including role/channel overwrites, and the bot's ability to send there. A selection covering **all eligible humans** requires the caller's **Mention Everyone** permission. This is checked on the final recipient set, so spelling out all IDs does not bypass it. Smaller selections do not require Mention Everyone, and role mentionability is intentionally not checked.

This is deliberately a full-audience rule, not a general anti-spam system: selecting everyone except one person or making several smaller requests is still allowed. In a channel with one eligible human, selecting that person is a full-audience selection and requires Mention Everyone.

The bot sends individual user mentions only. Literal `@everyone`, `@here`, role mentions, and unselected user mentions in the message cannot expand the recipient list. Discord exposes whether sending is permitted, **not** whether someone will receive a push notification or has personal notification suppression enabled.

Scripts also receive the last 10 messages of the channel (oldest first): author id, author display name, whether the author is a bot, content truncated to 2,000 characters, and an ISO timestamp. This is the same history anyone who can run `/ping` there can already scroll, and it is best-effort — if the bot lacks Read Message History, or the Message Content intent is off, scripts see an empty list or empty content rather than an error. Message content never affects who can be pinged; recipients are still checked against the eligible member snapshot.

Members are fetched using paginated REST requests before selection (avoiding the Gateway full-member-request rate limit); a partial member cache is not used as the audience. A preview lasts five minutes and holds the exact selected IDs. Sending rechecks permissions and removes recipients who left or lost channel access; it never adds new matches. A preview can be used once, only by its author, in its original channel. Creating a new preview replaces the author's previous preview. Restarting the bot expires all previews.

Messages are split at 2,000 characters / 100 explicitly allowed user mentions, repeating the message text in each batch. Each selected ID occurs in one batch. On delivery failure the bot reports confirmed progress and does not retry the whole audience; an ambiguous failed network request may still have reached Discord. Permission and membership changes during delivery cannot be made atomic with Discord.

Normal text and announcement channels are supported. Threads, voice-channel chats, DMs, repeated ping counts, and saved scripts are not implemented.

## Architecture

```text
Discord command → SelectionLanguage.compile(source, context)
                → { recipients, message }
                → host validation + permission preview
                → recheck + batched delivery
```

A new language implements `SelectionLanguage`:

```ts
interface SelectionLanguage {
  readonly id: string;
  compile(source: string, context: CompileContext): Promise<PingPlan>;
}
```

Register it in the map in `src/languages/index.ts` and expose a command/editor choice; the editor modal already carries the language id in its `customId`. The host always validates the result. Adapters get plain snapshots, never the Discord client or credentials. Sing keeps its syntax tree internal to its adapter; the host needs no language-specific AST, plugin loader, or database. The shared audience tests take adapter-specific source strings and assert language-independent behavior.

## Execution bounds

The Sing interpreter runs in a fresh worker with an empty environment and a 64 MiB JavaScript old-generation
heap limit. It interprets a closed syntax tree, never JavaScript or Lua source, and exposes only
plain snapshot fields and documented built-ins. It shares the source, startup, execution, and
output limits below. Additional Sing bounds are 1,000,000 evaluation work units (including set
and string work), 100 levels of parser/execution/type/collection nesting, 16,000 elements/fields per list/record, 16,000 UTF-16 code units per
intermediate string, and 16,000 decimal digits per exact integer. Worker limits are not a total process RSS limit. See the
[Sing reference](docs/sing.md) for details.

Lua runs in a fresh worker with an empty environment and no JavaScript object proxies. One narrow host callback resolves a member name to an ID using the shared resolver in `src/members.ts`; it has no Discord client, filesystem, or network access. User code receives an explicit Lua environment: no `io`, `os`, `package`, `require`, `debug`, `load`, or filesystem/network APIs. Unknown globals go through one metamethod that resolves a bare name to a role or member using that same callback, and evaluates to `nil` when nothing matches, so a typo still fails as a nil value. Loading source uses Lua's text-only mode.

- Source: 16,000 UTF-8 bytes (Discord's editor/option is additionally capped at 4,000 characters).
- Lua execution: 2 seconds, enforced by terminating the worker; runtime startup: 10 seconds.
- Lua allocations: 16 MiB; worker JavaScript old-generation heap: 64 MiB. These are not a total process RSS limit.
- Context: the last 10 channel messages, each truncated to 2,000 characters.
- Output: at most 5,000 IDs, a nonempty message of at most 1,500 UTF-16 code units.
- At most four concurrent preparations, one per caller.

Lua output must be a dense list of IDs. The host checks membership in the eligible snapshot and removes duplicates. No nesting/depth validation is needed for this flat contract. The Wasm runtime and worker are useful resource boundaries, not an OS-level security sandbox; for a public service accepting hostile code, use a separately constrained process/container and review the runtime boundary.

## Check behavior

```sh
pnpm run check   # lint, format check, typecheck, tests
pnpm test
pnpm run preview examples/class.sing examples/context.json
pnpm run preview examples/class.lua examples/context.json lua
```

The test suite covers both language adapters, Sing name matching and diagnostics, control flow, runaway/memory failures, host isolation, full-audience authorization, notification batching, and partial delivery. Future language adapters can reuse `selectionContract` with their own scenario source strings. Tests run against the built output in `dist/`, because the Lua adapter resolves its worker and `runtime.lua` relative to its own compiled location; the Vitest global setup builds first, so a bare `vitest` cannot test stale output. CI runs `pnpm run check` without a bot token. `AGENTS.md` covers the conventions for changing this code.

For a live smoke test, run `/ping` in the test server and use the default Sing
`PING CALLER SAYING "The siren calls!"` script. Check the private preview, send, and confirm the bot mentions only you. Also try Cancel and a script with `@everyone` using an account without Mention Everyone; it should preview as blocked. Automated local tests do not prove actual notification delivery.

Lua is covered by local automated tests; after changing the default, live Discord behavior must be
checked again with `pnpm run register`. A Lua smoke test is `/ping language:Lua` with the default
`member(caller_id)` script, followed by preview, Send ping, and Cancel.

Live Lua validation on 2026-09-18: installed in the test server, registered `/ping`, opened the Lua modal, previewed a self-only selection, and sent one message mentioning only the invoking user. Verified the visible message and Discord API response (`mention_everyone: false`). The first live send revealed a Gateway member-fetch rate limit; switching to REST pagination resolved it. Full-audience denial is covered by the shared policy test, not a second live user account.
