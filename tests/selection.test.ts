import { describe, expect, it } from 'vitest';
import { SingSelectionLanguage } from '../dist/languages/sing/index.js';
import { LuaSelectionLanguage } from '../dist/languages/lua/index.js';
import { batches, deliver, limits, permissionProblem, validatePlan } from '../dist/selection.js';
import type { CompileContext, SelectionLanguage } from '../dist/selection.js';

const context: CompileContext = {
  callerId: '101',
  roles: [
    { id: '10', name: 'L1' },
    { id: '20', name: 'L2' },
  ],
  members: [
    { id: '101', name: 'Yara', roleIds: [], joinedAt: '2026-09-01T00:00:00.000Z' },
    { id: '102', name: 'Both roles', roleIds: ['10', '20'], joinedAt: '2026-09-01T00:00:00.000Z' },
    {
      id: '103',
      name: 'Zoë',
      username: 'zoe42',
      globalName: 'Zoë Fairweather',
      roleIds: ['20'],
      joinedAt: '2026-09-01T00:00:00.000Z',
    },
    { id: '104', name: 'Bóth roles', roleIds: [], joinedAt: '2026-09-19T00:00:00.000Z' },
  ],
  messages: [
    {
      id: '9001',
      authorId: '103',
      authorName: 'Zoë',
      bot: false,
      content: 'is the class still on?',
      createdAt: '2026-09-19T09:00:00.000Z',
    },
    {
      id: '9002',
      authorId: '101',
      authorName: 'Yara',
      bot: true,
      content: 'asking now',
      createdAt: '2026-09-19T09:01:00.000Z',
    },
  ],
};

// Each future adapter supplies its spelling of these scenarios. Assertions stay shared.
function selectionContract(
  language: SelectionLanguage,
  scripts: {
    exclude: string;
    overlap: string;
    empty: string;
    invalid: string;
    named: string[];
    ambiguous: string;
  },
) {
  describe(`${language.id}: audience contract`, () => {
    it('excludes overlapping roles and recent arrivals', async () => {
      const plan = validatePlan(await language.compile(scripts.exclude, context), context);
      expect(plan).toEqual({ recipients: ['101'], message: 'Class is cancelled' });
    });
    it('mentions each person once when groups overlap', async () => {
      const plan = validatePlan(await language.compile(scripts.overlap, context), context);
      expect(plan.recipients.toSorted()).toEqual(['102', '103']);
    });
    it('resolves names, usernames and mentions to the same excluded person', async () => {
      for (const source of scripts.named) {
        const plan = validatePlan(await language.compile(source, context), context);
        expect(plan.recipients).toEqual(['101', '102', '104']);
      }
    });
    it('rejects ambiguous names instead of selecting an arbitrary person', async () => {
      await expect(language.compile(scripts.ambiguous, context)).rejects.toThrow(
        'Ambiguous member name',
      );
    });
    it('treats an empty result as a no-op and rejects unknown recipients', async () => {
      const empty = validatePlan(await language.compile(scripts.empty, context), context);
      expect(batches(empty)).toEqual([]);
      expect(permissionProblem(empty, context, true)).toContain('No matches found');
      await expect(
        language.compile(scripts.invalid, context).then(plan => validatePlan(plan, context)),
      ).rejects.toThrow();
    });
  });
}

const lua = new LuaSelectionLanguage();
selectionContract(lua, {
  exclude:
    'return { recipients = everyone() - (role("L1") + role("L2")) - joined_after("2026-09-18"), message = "Class is cancelled" }',
  overlap: 'return { recipients = role("L1") + role("L2"), message = "Hello" }',
  empty: 'return { recipients = everyone() - everyone(), message = "Hello" }',
  invalid: 'return { recipients = {"999"}, message = "Hello" }',
  named: [
    '103',
    '<@103>',
    '<@!103>',
    'zoe42',
    '@zoe42',
    'Zoë',
    'Zoé',
    'Zoe',
    'ZOE',
    'Zoe\u0308',
    'Zoë Fairweather',
  ]
    .map(
      reference => `return { recipients = everyone() - member("${reference}"), message = "Hello" }`,
    )
    .concat('return { recipients = everyone() - zoe42, message = "Hello" }'),
  ambiguous: 'return { recipients = member("Both roles"), message = "Hello" }',
});

selectionContract(new SingSelectionLanguage(), {
  exclude: 'PING @everyone - (@L1 + @L2) - JOINED_AFTER("2026-09-18") SAYING "Class is cancelled"',
  overlap: 'PING @L1 OR @L2 SAYING "Hello"',
  empty: 'PING @everyone - @everyone SAYING "Hello"',
  invalid: 'PING MEMBER("999") SAYING "Hello"',
  named: [
    '103',
    '<@103>',
    '<@!103>',
    'zoe42',
    '@zoe42',
    'Zoë',
    'Zoé',
    'Zoe',
    'ZOE',
    'Zoe\u0308',
    'Zoë Fairweather',
  ]
    .map(reference => `PING @everyone - MEMBER(${JSON.stringify(reference)}) SAYING "Hello"`)
    .concat('PING @everyone - @Zoë SAYING "Hello"'),
  ambiguous: 'PING @Both roles SAYING "Hello"',
});

describe('host validation of adapter results', () => {
  // The host repeats what runtime.lua and Sing already check, so a future adapter cannot widen
  // the audience by returning something the language would have refused.
  it.each([
    ['not an object', null, 'Return a ping'],
    ['a string instead of a plan', 'ping everyone', 'Return a ping'],
    ['no message', { recipients: ['101'] }, 'message must contain'],
    ['a blank message', { recipients: ['101'], message: '  \n ' }, 'message must contain'],
    [
      'an overlong message',
      { recipients: ['101'], message: 'x'.repeat(limits.messageLength + 1) },
      'message must contain',
    ],
    ['recipients that are not an array', { recipients: '101', message: 'hi' }, 'array of at most'],
    [
      'more recipients than the limit',
      { recipients: Array.from({ length: limits.recipients + 1 }, () => '101'), message: 'hi' },
      `array of at most ${limits.recipients}`,
    ],
    ['a non-string recipient', { recipients: [101], message: 'hi' }, 'Unknown or ineligible'],
    ['an ID nobody in the channel has', { recipients: ['999'], message: 'hi' }, '999'],
    ['an object posing as an ID', { recipients: [{ id: '101' }], message: 'hi' }, 'ineligible'],
  ])('rejects a plan with %s', (_case, plan, message) => {
    expect(() => validatePlan(plan, context)).toThrow(message);
  });

  it('delivers to a repeated recipient once', () => {
    const plan = validatePlan({ recipients: ['101', '101', '102'], message: 'hi' }, context);
    expect(plan.recipients).toEqual(['101', '102']);
  });

  it('accepts a plan at the message and recipient limits', () => {
    const message = 'x'.repeat(limits.messageLength);
    expect(validatePlan({ recipients: ['101'], message }, context)).toEqual({
      recipients: ['101'],
      message,
    });
  });
});

it('runs Lua loops and functions over the member snapshot', async () => {
  const source =
    'local ids = {}; for _, m in ipairs(members) do if m.id == caller_id then ids[#ids+1] = m.id end end; return { recipients = ids, message = "hi" }';
  expect(validatePlan(await lua.compile(source, context), context).recipients).toEqual(['101']);
});

it('terminates a runaway Lua script and stays usable afterwards', async () => {
  await expect(lua.compile('while true do end', context)).rejects.toThrow('execution limit');
  const plan = await lua.compile('return { recipients = {}, message = "hi" }', context);
  expect(plan.message).toBe('hi');
});

it.each([
  ['the environment', 'os.getenv("DISCORD_TOKEN")'],
  ['the filesystem', 'io.open("/etc/passwd")'],
  ['module loading', 'require("fs")'],
  ['loading more code', 'load("return 1")'],
  ['the debug library', 'debug.getinfo(1)'],
  ['the package table', 'package.path'],
])('denies untrusted Lua access to %s', async (_case, expression) => {
  await expect(
    lua.compile(`return {recipients={}, message=tostring(${expression})}`, context),
  ).rejects.toThrow();
});

it('stops a Lua script that tries to exhaust memory', async () => {
  await expect(
    lua.compile('return {recipients={}, message=string.rep("x", 32 * 1024 * 1024)}', context),
  ).rejects.toThrow();
});

it('reports a Lua syntax error by line, and explains an unquoted name', async () => {
  await expect(lua.compile('return {', context)).rejects.toThrow(/^Line 1:/);
  await expect(lua.compile('return { recipients = @zoe42 }', context)).rejects.toThrow(
    'Put names in quotes',
  );
});

it('enforces the shared limits inside Lua, not just at the host boundary', async () => {
  const source = `local ids = {}
    for i = 1, ${limits.recipients + 1} do ids[i] = "101" end
    return { recipients = ids, message = "hi" }`;
  await expect(lua.compile(source, context)).rejects.toThrow(`maximum ${limits.recipients}`);
});

it('resolves bare role and member names, and keeps unmatched globals nil', async () => {
  const run = async (source: string) =>
    validatePlan(await lua.compile(source, context), context).recipients.toSorted();
  expect(await run('return { recipients = caller, message = "hi" }')).toEqual(['101']);
  expect(await run('return { recipients = L1 + L2, message = "hi" }')).toEqual(['102', '103']);
  expect(await run('return { recipients = zoe42, message = "hi" }')).toEqual(['103']);
  // A typo is still a nil value, not a member lookup failure.
  await expect(
    lua.compile('return { recipients = everyon(), message = "hi" }', context),
  ).rejects.toThrow('nil value');
});

it('exposes recent channel messages to the script', async () => {
  const source = `local lines = {}
    for _, m in ipairs(messages) do lines[#lines+1] = m.authorName..": "..m.content end
    return { recipients = {}, message = table.concat(lines, " | ").." /"..tostring(messages[2].bot) }`;
  const plan = await lua.compile(source, context);
  expect(plan.message).toBe('Zoë: is the class still on? | Yara: asking now /true');
});

it('requires Mention Everyone for a full audience regardless of how IDs were selected', () => {
  const all = { recipients: context.members.map(member => member.id), message: 'hi' };
  expect(permissionProblem(all, context, false)).toContain('Mention Everyone');
  expect(permissionProblem(all, context, true)).toBeUndefined();
  expect(permissionProblem({ ...all, recipients: ['102'] }, context, false)).toBeUndefined();
});

const crowd = {
  recipients: Array.from({ length: 240 }, (_, i) => String(100000000000000000n + BigInt(i))),
  message: '@everyone <@&123> ' + 'x'.repeat(1400),
};

it('mentions only the selected users, within Discord’s message and mention limits', () => {
  const sent = batches(crowd);
  expect(sent.flatMap(batch => batch.allowedMentions.users)).toEqual(crowd.recipients);
  for (const batch of sent) {
    expect(batch.content.length).toBeLessThanOrEqual(2000);
    expect(batch.allowedMentions.users.length).toBeLessThanOrEqual(100);
    // Neither the literal @everyone in the message nor a role mention may resolve.
    expect(batch.allowedMentions.parse).toEqual([]);
    for (const id of batch.allowedMentions.users) expect(batch.content).toContain(`<@${id}>`);
  }
});

it('stops delivery after a failure and reports only confirmed messages', async () => {
  let calls = 0;
  const result = await deliver(crowd, async () => {
    if (++calls === 2) throw new Error('Discord unavailable');
  });
  expect(calls).toBe(2);
  expect(result).toEqual({
    complete: false,
    sentMessages: 1,
    sentRecipients: batches(crowd)[0]!.allowedMentions.users.length,
  });
});
