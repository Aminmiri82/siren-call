import { describe, expect, it } from 'vitest';
import { LuaSelectionLanguage } from '../dist/languages/lua/index.js';
import { batches, deliver, permissionProblem, validatePlan } from '../dist/selection.js';
import type { CompileContext, SelectionLanguage } from '../src/selection.js';

const context: CompileContext = {
  callerId: '101',
  roles: [{ id: '10', name: 'L1' }, { id: '20', name: 'L2' }],
  members: [
    { id: '101', name: 'Yara', roleIds: [], joinedAt: '2026-09-01T00:00:00.000Z' },
    { id: '102', name: 'Both roles', roleIds: ['10', '20'], joinedAt: '2026-09-01T00:00:00.000Z' },
    { id: '103', name: 'chèvre', username: 'raphe22', globalName: 'Raphaël', roleIds: ['20'], joinedAt: '2026-09-01T00:00:00.000Z' },
    { id: '104', name: 'Bóth roles', roleIds: [], joinedAt: '2026-09-19T00:00:00.000Z' },
  ],
};

// Each future adapter supplies its spelling of these scenarios. Assertions stay shared.
function selectionContract(language: SelectionLanguage, scripts: { exclude: string; overlap: string; empty: string; invalid: string; named: string[]; ambiguous: string }) {
  describe(`${language.id}: audience contract`, () => {
    it('excludes overlapping roles and recent arrivals', async () => {
      const plan = validatePlan(await language.compile(scripts.exclude, context), context);
      expect(plan).toEqual({ recipients: ['101'], message: 'Class is cancelled' });
    });
    it('mentions each person once when groups overlap', async () => {
      const plan = validatePlan(await language.compile(scripts.overlap, context), context);
      expect([...plan.recipients].sort()).toEqual(['102', '103']);
    });
    it('resolves names, usernames and mentions to the same excluded person', async () => {
      for (const source of scripts.named) {
        const plan = validatePlan(await language.compile(source, context), context);
        expect(plan.recipients).toEqual(['101', '102', '104']);
      }
    });
    it('rejects ambiguous names instead of selecting an arbitrary person', async () => {
      await expect(language.compile(scripts.ambiguous, context)).rejects.toThrow('Ambiguous member name');
    });
    it('treats an empty result as a no-op and rejects unknown recipients', async () => {
      const empty = validatePlan(await language.compile(scripts.empty, context), context);
      expect(batches(empty)).toEqual([]);
      expect(permissionProblem(empty, context, true)).toContain('No eligible');
      await expect(language.compile(scripts.invalid, context).then(plan => validatePlan(plan, context))).rejects.toThrow();
    });
  });
}

const lua = new LuaSelectionLanguage();
selectionContract(lua, {
  exclude: 'return { recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"), message = "Class is cancelled" }',
  overlap: 'return { recipients = role("L1") + role("L2"), message = "Hello" }',
  empty: 'return { recipients = everyone() - everyone(), message = "Hello" }',
  invalid: 'return { recipients = {"999"}, message = "Hello" }',
  named: ['103', '<@103>', '<@!103>', 'raphe22', '@raphe22', 'chèvre', 'chévre', 'chevre', 'CHEVRE', 'che\u0300vre', 'Raphaël'].map(reference =>
    `return { recipients = everyone() - member("${reference}"), message = "Hello" }`),
  ambiguous: 'return { recipients = member("Both roles"), message = "Hello" }',

});

it('allows Lua loops and functions but terminates runaway scripts and stays usable', async () => {
  const source = 'local ids = {}; for _, m in ipairs(members) do if m.id == caller_id then ids[#ids+1] = m.id end end; return { recipients = ids, message = "hi" }';
  expect(validatePlan(await lua.compile(source, context), context).recipients).toEqual(['101']);
  await expect(lua.compile('while true do end', context)).rejects.toThrow('execution limit');
  expect((await lua.compile(source, context)).message).toBe('hi');
}, 15_000);

it('does not expose host access, and rejects malformed or memory-exhausting scripts', async () => {
  await expect(lua.compile('return {recipients={}, message=tostring(os.getenv("DISCORD_TOKEN"))}', context)).rejects.toThrow();
  await expect(lua.compile('return {', context)).rejects.toThrow(/^Line 1:/);
  await expect(lua.compile('return { recipients = @raphe22 }', context)).rejects.toThrow('Put names in quotes');
  await expect(lua.compile('return {recipients={}, message=string.rep("x", 32 * 1024 * 1024)}', context)).rejects.toThrow();
});

it('requires Mention Everyone for a full audience regardless of how IDs were selected', () => {
  const all = { recipients: context.members.map(member => member.id), message: 'hi' };
  expect(permissionProblem(all, context, false)).toContain('Mention Everyone');
  expect(permissionProblem(all, context, true)).toBeUndefined();
  expect(permissionProblem({ ...all, recipients: ['102'] }, context, false)).toBeUndefined();
});

it('delivers only selected user mentions within Discord limits, with no automatic repeat after failure', async () => {
  const plan = { recipients: Array.from({ length: 240 }, (_, i) => String(100000000000000000n + BigInt(i))), message: '@everyone <@&123> ' + 'x'.repeat(1400) };
  const sent = batches(plan);
  expect(sent.flatMap(batch => batch.allowedMentions.users)).toEqual(plan.recipients);
  for (const batch of sent) {
    expect(batch.content.length).toBeLessThanOrEqual(2000);
    expect(batch.allowedMentions.users.length).toBeLessThanOrEqual(100);
    expect(batch.allowedMentions.parse).toEqual([]);
    for (const id of batch.allowedMentions.users) expect(batch.content).toContain(`<@${id}>`);
  }
  let calls = 0;
  const result = await deliver(plan, async () => { if (++calls === 2) throw new Error('Discord unavailable'); });
  expect(calls).toBe(2);
  expect(result).toEqual({ complete: false, sentMessages: 1, sentRecipients: sent[0]!.allowedMentions.users.length });
});
