# Siren Call

A Discord bot for doing arithmetic on pings, using Lua.

```lua
return {
  recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"),
  message = "Class is cancelled"
}
```

`/ping` opens a Lua editor. Submit a script to get a private recipient/permission preview, then choose **Send ping** or **Cancel**. You can also put short scripts directly in `/ping script:...`.

## Run locally

Requires Node.js 24.17+ and a Discord bot application.

```sh
npm ci
cp .env.example .env
# Add your bot token to .env (never commit it).
npm run register
npm run dev
```

If `.env` already exists, edit it instead of copying over it. `.env` and `.env.*` are ignored, except the empty `.env.example` template.

The default application is `1550468456678170684`, and commands are registered only in test server `1422967166088773664`. Override these with `DISCORD_APPLICATION_ID` and `DISCORD_GUILD_ID`.

In the [Developer Portal](https://discord.com/developers/applications/1550468456678170684/bot), enable **Server Members Intent** and save. Presence and Message Content intents are not needed. This bot uses a Gateway connection, so it needs no public web server, interactions endpoint, or public-key configuration.

[Install SirenCall in the test server](https://discord.com/oauth2/authorize?client_id=1550468456678170684&scope=bot%20applications.commands&permissions=19456&guild_id=1422967166088773664&disable_guild_select=true). Requested permissions: View Channels, Send Messages, Embed Links. No Administrator, Manage Roles, or Mention Everyone permission for the bot.

The process must stay running for the bot to respond. `npm start` runs the built output; `npm run dev` rebuilds first. Command registration upserts only `/ping`, leaving other commands alone.

## Lua API

Scripts return `{ recipients = <list of ID strings>, message = <string> }`. IDs stay strings so Discord snowflakes never lose precision.

| API | Meaning |
| --- | --- |
| `everyone()` | Human members who can view this channel |
| `role("L1")` | Eligible members with this role; use the role ID if names collide |
| `member("123...")` | One eligible member |
| `member(caller_id)` | Yourself |
| `joined_after("2026-09-18")` | Joined strictly after midnight UTC on this date |
| `select(function(m) return ... end)` | Select by a Lua predicate |
| `a + b`, `union(a,b)` | Union, without duplicates |
| `a - b`, `difference(a,b)` | Difference |
| `a * b`, `intersection(a,b)` | Intersection |
| `members` | Array of eligible member snapshots |

Member fields: `id`, `name` (server display name), `roleIds`, `joinedAt` (ISO UTC string, or `nil` if unknown). Unknown join dates do not match `joined_after`. Role names are exact and case-sensitive. The `@everyone` role can also be selected by the guild ID.

Use parentheses when mixing operators: Lua gives `*` higher precedence than `+` and `-`. Ordinary Lua variables, loops, functions, and the `math`, `string`, `table`, and `utf8` libraries are available.

```lua
local selected = {}
for _, person in ipairs(members) do
  if person.id == caller_id then
    selected[#selected + 1] = person.id
  end
end
return { recipients = selected, message = "The siren calls!" }
```

## Permissions and preview semantics

The bot checks the caller's effective channel permissions, including role/channel overwrites, and the bot's ability to send there. A selection covering **all eligible humans** requires the caller's **Mention Everyone** permission. This is checked on the final recipient set, so spelling out all IDs does not bypass it. Smaller selections do not require Mention Everyone, and role mentionability is intentionally not checked.

This is deliberately a full-audience rule, not a general anti-spam system: selecting everyone except one person or making several smaller requests is still allowed. In a channel with one eligible human, selecting that person is a full-audience selection and requires Mention Everyone.

The bot sends individual user mentions only. Literal `@everyone`, `@here`, role mentions, and unselected user mentions in the message cannot expand the recipient list. Discord exposes whether sending is permitted, **not** whether someone will receive a push notification or has personal notification suppression enabled.

Members are fetched before selection; a partial member cache is not used as the audience. A preview lasts five minutes and holds the exact selected IDs. Sending rechecks permissions and removes recipients who left or lost channel access; it never adds new matches. A preview can be used once, only by its author, in its original channel. Creating a new preview replaces the author's previous preview. Restarting the bot expires all previews.

Messages are split at 2,000 characters / 100 explicitly allowed user mentions, repeating the message text in each batch. Each selected ID occurs in one batch. On delivery failure the bot reports confirmed progress and does not retry the whole audience; an ambiguous failed network request may still have reached Discord. Permission and membership changes during delivery cannot be made atomic with Discord.

Normal text and announcement channels are supported. Threads, voice-channel chats, DMs, repeated ping counts, saved scripts, and a custom language are not implemented.

## Architecture

```text
Discord command → SelectionLanguage.compile(source, context)
                → { recipients, message }
                → host validation + permission preview
                → recheck + batched delivery
```

- `src/selection.ts`: plain types, output validation, permission policy, batching, and delivery outcomes.
- `src/languages/lua/`: Wasmoon Lua adapter and isolated execution worker.
- `src/discord/`: Discord data conversion, interaction UI, and configuration.
- `src/preview.ts`: run the same language contract without Discord.

A new language implements `SelectionLanguage`:

```ts
interface SelectionLanguage {
  readonly id: string;
  compile(source: string, context: CompileContext): Promise<PingPlan>;
}
```

Register its implementation in the language map and expose a command/editor choice. The host always validates the result. Adapters get plain snapshots, never the Discord client or credentials. No query AST, plugin loader, or database is needed. The shared audience tests take adapter-specific source strings and assert language-independent behavior.

## Execution bounds

Lua runs in a fresh worker with an empty environment and no JavaScript proxies/callbacks. User code receives an explicit Lua environment: no `io`, `os`, `package`, `require`, `debug`, `load`, or filesystem/network APIs. Loading source uses Lua's text-only mode.

- Source: 16,000 UTF-8 bytes (Discord's editor/option is additionally capped at 4,000 characters).
- Lua execution: 2 seconds, enforced by terminating the worker; runtime startup: 10 seconds.
- Lua allocations: 16 MiB; worker JavaScript old-generation heap: 64 MiB. These are not a total process RSS limit.
- Output: at most 5,000 IDs, a nonempty message of at most 1,500 UTF-16 code units.
- At most four concurrent preparations, one per caller.

Lua output must be a dense list of IDs. The host checks membership in the eligible snapshot and removes duplicates. No nesting/depth validation is needed for this flat contract. The Wasm runtime and worker are useful resource boundaries, not an OS-level security sandbox; for a public service accepting hostile code, use a separately constrained process/container and review the runtime boundary.

## Check behavior

```sh
npm test
npm run preview -- examples/class.lua examples/context.json
```

The small test suite covers recipient semantics, arbitrary Lua control flow, runaway/memory failures, host isolation, full-audience authorization, notification batching, and partial delivery. Future language adapters can reuse `selectionContract` with their own scenario source strings. CI runs the same build and tests without a bot token.

For a live smoke test, run `/ping` in the test server and use the default `member(caller_id)` script. Check the private preview, send, and confirm the bot mentions only you. Also try Cancel and a script with `everyone()` using an account without Mention Everyone; it should preview as blocked. Automated local tests do not prove actual notification delivery.
