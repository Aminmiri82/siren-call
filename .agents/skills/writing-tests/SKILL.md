---
name: writing-tests
description: Add or revise Siren Call tests, including regression tests for bug fixes. Not needed just to run existing checks.
---

# Writing Siren Call Tests

## Choose the promise

Read the relevant behavior in [README.md](../../../README.md) or the
[Sing specification](../../../docs/sing-spec.md), and preserve the boundaries in
[AGENTS.md](../../../AGENTS.md). Inspect the relevant existing tests before adding new ones.

Name the promise and the harm a regression would cause. Ask what defect the test catches that
types, lint, or an existing test would not. Organize tests around those risks, not one test file
per source file or a coverage target. Do not add tests just to restate an implementation.

For Siren Call, promises include selecting the intended people, refusing unauthorized sends,
preventing repeated delivery, preserving exact arithmetic and actionable diagnostics, and
bounding untrusted scripts without exposing host capabilities.

## Choose the cheapest realistic boundary

- Pure rules: test inputs and outcomes for host validation, permissions, batching, name matching,
  or standalone language semantics.
- Language adapters: run the real adapter and worker when proving sandbox restrictions,
  resource bounds, worker transport, or recovery after a failed script. A direct interpreter
  test cannot prove worker isolation or termination.
- Discord workflows: exercise the real application decisions with controlled external inputs
  and an explicit transport boundary. Observe rejected actions, recipient IDs, outbound mention
  restrictions, and confirmed delivery progress. Control time for preview expiry; coordinate
  concurrent actions explicitly rather than relying on sleeps.
- Live Discord: use a scoped smoke test when the claim requires the actual service. Local
  tests cannot prove command registration, Discord permission behavior, or notification delivery.
  Do not silently turn a local test run into registration or real messages; obtain authorization
  for those actions if the task does not already provide it.

Keep tests in `tests/` and import application code from `../dist/…`, not `src/`.
Vitest's global setup builds the code so workers and Lua resources resolve correctly.
There is no need to introduce new runners or reorganize the suite to express these boundaries.

## Write assertions that survive refactors

- State the product or language rule in the test name. Separate unrelated promises so failures
  identify the broken behavior; use table-driven cases when they express the same rule.
- Assert public results and failures, not private helpers, AST layout, or internal call order.
  Calls are valid evidence when they are the external behavior: which Discord payload was sent,
  whether a second send occurred, or whether delivery stopped after failure.
- Keep internal application logic real. Substitute true external boundaries, nondeterministic
  inputs such as time, and explicit failure points. If a test needs extensive internal module
  mocking, consider a small pure function or explicit dependency boundary instead.
- Use controlled fixtures independent of live members, credentials, network access, and test
  order. Restore altered clocks, globals, and other shared state. Keep real worker timers for
  worker termination tests; avoid tight elapsed-time assertions.
- Prefer explicit assertions over broad snapshots. Diagnostic codes, source spans, and useful
  message fragments are meaningful contracts; incidental formatting usually is not.
- Never weaken an assertion merely to pass, encode a known bug as the desired outcome, or
  remove security checks to simplify a test. If a product rule changes, say so and update its
  specification and test together.

Host validation deliberately repeats adapter checks. Test malformed adapter-shaped results
directly against `validatePlan`: rejection by Lua or Sing alone does not prove the host boundary.
Use shared `limits` where appropriate rather than introducing another set of runtime limits.

## Build on existing examples

- [selection.test.ts](../../../tests/selection.test.ts): extend `selectionContract` for shared
  audience behavior, supplying language-specific source with identical assertions. The delivery
  test also demonstrates failure injection at the outbound send boundary.
- [sing.test.ts](../../../tests/sing.test.ts): adapter behavior, name ambiguity, diagnostics,
  resource limits, and usability after rejection.
- [sing-core.test.ts](../../../tests/sing-core.test.ts): exact arithmetic, CLI behavior, worker
  transport, and comparison with an independent counter-machine model. Expected results should
  come from the specification or an independent model, not the implementation under test.
- [context.test.ts](../../../tests/context.test.ts): converting Discord inputs to eligible plain
  snapshots. Keep Discord objects outside language adapters.

For preview/send changes, consider ownership and channel binding, expiry, cancellation,
replacement, concurrent duplicate clicks, changed permissions, and removing newly ineligible
recipients without adding new matches. These are candidate promises to protect, not a claim
that the current suite covers them or a requirement to add them all for every change.

## Verify and report

For a bug fix, reproduce the failure with a regression test before applying the fix when
runnable, then demonstrate success afterward. Report when that before/after evidence could
not be obtained. For a refactor, keep behavioral assertions stable; flag implementation-coupled
tests rather than contorting production code to satisfy them.

Run the relevant suite first, for example `pnpm test tests/selection.test.ts`.
Run `pnpm run typecheck` after test edits: the default TypeScript configuration covers `src/`
only, while this command also checks test types. Run `pnpm run lint`; use `pnpm run check`
for the complete lint, formatting, typecheck, and test checks when appropriate to the change.
Do not keep repeating successful checks without a new change or unresolved concern.

For a nontrivial new test, briefly explain the promise, regression harm, chosen boundary, and
observable evidence. Report the checks actually run and their outcomes, including failures,
skipped checks, and the limits of local proof. Never describe a local transport substitute as
successful live Discord delivery.
