# Working on Siren Call

A Discord bot that runs a user-supplied Lua or Sing script to choose ping recipients, previews the result,
then sends it. Read `README.md` for the user-facing semantics; this file is about changing the code.

## The one non-obvious thing

**Tests import from `dist/`, not `src/`.** The Lua adapter resolves `worker.js` and `runtime.lua`
relative to its own compiled location, so it only works from built output. `vitest.config.ts` runs
the build in `globalSetup`, so `pnpm test` and a bare `vitest` are both safe — but if you add a
test, import from `../dist/…`, and run `pnpm run typecheck` to check test types (the default
`tsconfig.json` covers `src/` only).

## Boundaries that must hold

These are load-bearing. Changing them needs a deliberate decision, not a drive-by edit.

- **User Lua is untrusted.** It runs in a worker with `env: {}` (so it cannot read the bot token),
  an explicit Lua environment with no `io`/`os`/`package`/`require`/`debug`/`load`, a memory cap,
  and a kill timer. The only host callback is `resolve_member`: a string in, an ID or an error out.
- **Adapters never see Discord objects.** `toCompileContext` in `src/discord/context.ts` is the only
  place Discord types become plain snapshots. Everything downstream takes `CompileContext`.
- **The host re-validates every adapter result.** `validatePlan` repeats checks that `runtime.lua`
  already makes. That is intentional: Lua's checks are for good error messages, the host's are the
  actual guarantee, and they must keep holding for a future non-Lua adapter.
- **Limits live in `limits` in `src/selection.ts`** and are injected into Lua by the worker. Do not
  hardcode a second copy in `runtime.lua`.
- **Sing is also untrusted.** Its interpreter runs in an empty-environment worker with a kill
  timer and heap limit. Preserve its work, nesting, and string limits and source-span diagnostics.
  Never replace interpretation with JavaScript evaluation or expose host objects to scripts.

## Adding a selection language

1. Implement `SelectionLanguage` (`src/selection.ts`) in `src/languages/<id>/`.
2. Register it in the map in `src/languages/index.ts`.
3. Add a `language` option to `/ping` in `src/discord/register.ts` and pass the chosen id from
   `src/discord/bot.ts` through `preview(...)` in `src/discord/ping.ts`. Update language-specific
   labels and starter scripts in `src/discord/ui.ts`. The editor modal already carries the id in its
   `customId` (`ping:<id>`), so `handleButton`/`preview` need no other change.
4. Extend `selectionContract` in `tests/selection.test.ts` with your spelling of the same scenarios.
   The assertions are language-independent on purpose; do not weaken them per adapter.

## Style

Prettier (100 cols, single quotes) and oxlint decide formatting and lint; run `pnpm run lint`.
Comments here explain _why_. Do not add comments that restate the code.
