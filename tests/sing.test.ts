import { describe, expect, it } from 'vitest';
import { SingError, SingSelectionLanguage } from '../dist/languages/sing/index.js';
import { language, defaultLanguageId } from '../dist/languages/index.js';
import { scriptModal } from '../dist/discord/ui.js';
import { limits, validatePlan } from '../dist/selection.js';
import type { CompileContext } from '../dist/selection.js';

const sing = new SingSelectionLanguage();
const context: CompileContext = {
  callerId: '1',
  roles: [
    { id: '10', name: 'Teachers' },
    { id: '20', name: 'Café crew' },
    { id: '30', name: 'Research AND Development' },
    { id: '40', name: 'Teachers + Staff' },
    { id: '50', name: 'IF' },
    { id: '60', name: 'Teachers saying hello' },
  ],
  members: [
    { id: '1', name: 'John', roleIds: ['10'], joinedAt: null },
    {
      id: '2',
      name: 'John Doe',
      roleIds: ['10', '20', '30', '40', '50', '60'],
      joinedAt: '2026-09-19T00:00:00.000Z',
    },
    {
      id: '3',
      name: 'Zoë',
      username: 'zoe42',
      globalName: 'Zoë Fairweather',
      roleIds: ['20'],
      joinedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  messages: [
    {
      id: '900',
      authorId: '3',
      authorName: 'Zoë',
      bot: false,
      content: 'hello class',
      createdAt: '2026-09-19T09:00:00.000Z',
    },
  ],
};
const compile = (source: string, ctx = context) =>
  sing.compile(source, ctx).then(plan => validatePlan(plan, ctx));
const recipients = async (expression: string) =>
  (await compile(`PING ${expression} SAYING "Hello"`)).recipients;

describe('Sing names and set expressions', () => {
  it('uses @everyone as an audience reference and leaves EVERYONE available as a name', async () => {
    expect(await recipients('@everyone - @John Doe')).toEqual(['1', '3']);
    await expect(recipients('EVERYONE')).rejects.toThrow('Unknown variable');
    await expect(recipients('everyone')).rejects.toThrow('Unknown variable');
    expect((await compile('LET EVERYONE = CALLER; PING EVERYONE SAYING "hi"')).recipients).toEqual([
      '1',
    ]);
    const ctx = {
      ...context,
      members: [
        ...context.members,
        { id: '4', name: 'everyone', roleIds: [], joinedAt: null },
        { id: '5', name: 'everyone else', roleIds: [], joinedAt: null },
        { id: '6', name: 'everyonex', roleIds: [], joinedAt: null },
      ],
    };
    expect((await compile('PING @everyone SAYING "hi"', ctx)).recipients).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect((await compile('PING @"everyone" SAYING "hi"', ctx)).recipients).toEqual(['4']);
    expect((await compile('PING @"everyone else" SAYING "hi"', ctx)).recipients).toEqual(['5']);
    expect((await compile('PING @everyonex SAYING "hi"', ctx)).recipients).toEqual(['6']);
  });
  it('selects active members with @here and distinguishes unavailable presence from an empty result', async () => {
    const ctx: CompileContext = {
      ...context,
      presenceAvailable: true,
      members: [
        { ...context.members[0]!, presence: 'online' },
        { ...context.members[1]!, presence: 'dnd' },
        { ...context.members[2]!, presence: 'idle' },
        { id: '4', name: 'Offline', roleIds: [], joinedAt: null, presence: 'offline' },
        { id: '5', name: 'Unknown', roleIds: [], joinedAt: null, presence: null },
        { id: '6', name: 'here', roleIds: [], joinedAt: null },
      ],
    };
    expect((await compile('PING @here SAYING "hi"', ctx)).recipients).toEqual(['1', '2']);
    expect((await compile('PING @here - @John SAYING "hi"', ctx)).recipients).toEqual(['2']);
    expect((await compile('PING @"here" SAYING "hi"', ctx)).recipients).toEqual(['6']);
    expect((await compile('PING @here SAYING "hi"', { ...ctx, members: [] })).recipients).toEqual(
      [],
    );
    await expect(recipients('@here')).rejects.toThrow('requires available presence data');
    await expect(
      compile('PING @here SAYING "hi"', { ...ctx, presenceAvailable: false }),
    ).rejects.toThrow('requires available presence data');
    await expect(recipients('HERE')).rejects.toThrow('Unknown variable');
  });
  it('longest-matches multiword names, aliases and normalized Unicode', async () => {
    expect(await recipients('@Teachers - @John Doe')).toEqual(['1']);
    expect(await recipients('@Café crew')).toEqual(['2', '3']);
    for (const name of ['Zoë', 'ZOE', 'Zoe\u0308', 'zoe42', 'Zoë Fairweather']) {
      expect(await recipients('@' + name)).toEqual(['3']);
    }
    expect(await recipients('@"Teachers saying hello"')).toEqual(['2']);
    expect(await recipients('@"John"')).toEqual(['1']);
  });
  it('supports quoted syntax collisions and explicit IDs and mentions', async () => {
    for (const name of ['Research AND Development', 'Teachers + Staff', 'IF']) {
      expect(await recipients(`@${JSON.stringify(name)}`)).toEqual(['2']);
    }
    expect(await recipients('<@2> + <@!3>')).toEqual(['2', '3']);
    expect(await recipients('<@&10>')).toEqual(['1', '2']);
    expect(await recipients('ROLE("10") - MEMBER("2")')).toEqual(['1']);
  });
  it('keeps numeric, mention-shaped, and @-prefixed names literal', async () => {
    const ctx = {
      ...context,
      members: [
        ...context.members,
        { id: '4', name: '1', roleIds: [], joinedAt: null },
        { id: '5', name: '@John', roleIds: [], joinedAt: null },
        { id: '6', name: '<@1>', roleIds: [], joinedAt: null },
        { id: '7', name: 'ANDré', roleIds: [], joinedAt: null },
        { id: '8', name: '😀 friend', roleIds: [], joinedAt: null },
        { id: '9', name: 'Quote "friend"', roleIds: [], joinedAt: null },
      ],
    };
    for (const [name, id] of [
      ['1', '4'],
      ['@John', '5'],
      ['<@1>', '6'],
      ['ANDré', '7'],
      ['😀 friend', '8'],
      ['Quote "friend"', '9'],
    ]) {
      expect((await compile(`PING @${JSON.stringify(name)} SAYING "hi"`, ctx)).recipients).toEqual([
        id,
      ]);
    }
    expect((await compile('PING @1 + @ANDré + @😀 friend SAYING "hi"', ctx)).recipients).toEqual([
      '4',
      '7',
      '8',
    ]);
    expect((await compile('PING MEMBER("1") SAYING "hi"', ctx)).recipients).toEqual(['1']);
    expect((await compile('PING <@1> SAYING "hi"', ctx)).recipients).toEqual(['1']);
  });
  it('implements operators, precedence, grouping and stable deduplication', async () => {
    expect(await recipients('@Teachers AND @Café crew')).toEqual(['2']);
    expect(await recipients('@Teachers XOR @Café crew')).toEqual(['1', '3']);
    expect(await recipients('NOT @Teachers')).toEqual(['3']);
    expect(await recipients('@Teachers + @Teachers - @John Doe')).toEqual(['1']);
    expect(await recipients('@John OR @Teachers AND @Café crew')).toEqual(['1', '2']);
    expect(await recipients('(@John OR @Teachers) AND @Café crew')).toEqual(['2']);
    expect(await recipients('(\n @Teachers +\n @Café crew\n)')).toEqual(['1', '2', '3']);
  });
  it('rejects ambiguous people, roles and cross-kind names', async () => {
    const memberCollision = {
      ...context,
      members: [...context.members, { ...context.members[0]!, id: '4', name: 'Teachers' }],
    };
    await expect(compile('PING @Teachers SAYING "hi"', memberCollision)).rejects.toThrow(
      'matches a role and a member',
    );
    expect(
      (await compile('PING ROLE("Teachers") SAYING "hi"', memberCollision)).recipients,
    ).toEqual(['1', '2', '4']);
    const duplicate = {
      ...context,
      members: [...context.members, { ...context.members[0]!, id: '4' }],
    };
    await expect(compile('PING @John SAYING "hi"', duplicate)).rejects.toThrow(
      'Ambiguous member name',
    );
    const roles = { ...context, roles: [...context.roles, { id: '70', name: 'Teachers' }] };
    await expect(compile('PING @Teachers SAYING "hi"', roles)).rejects.toThrow(
      'Ambiguous role name',
    );
    expect((await compile('PING ROLE("10") SAYING "hi"', roles)).recipients).toEqual(['1', '2']);
  });
});

describe('Sing statements and context', () => {
  it.each(['lower', 'upper', 'mixed'])(
    'accepts %s case across keywords and built-ins',
    async style => {
      const source = `LET audience = NONE
LET remaining = 1
WHILE remaining > 0 DO
  FOR person IN MEMBERS DO
    IF person.joinedAt != NULL AND NOT FALSE THEN
      audience = audience OR MEMBER(person.id)
    ELSE
      audience = audience XOR NONE
    END
  END
  remaining = remaining - 1
END
FOR message IN MESSAGES DO
  IF CONTAINS(message.content, "class") AND TRUE THEN
    audience = audience AND (ROLE("Teachers") OR CALLER OR JOINED_AFTER("2026-09-18"))
  END
END
PING audience SAYING TEXT(COUNT(audience)) + " MiXeD PING"`;
      const transformed = source.replace(/\b[A-Z_]+\b(?=(?:[^"\n]*"[^"\n]*")*[^"\n]*$)/gm, word => {
        if (style === 'upper') return word;
        if (style === 'lower') return word.toLowerCase();
        return [...word].map((letter, i) => (i % 2 ? letter.toLowerCase() : letter)).join('');
      });
      expect(await compile(transformed)).toEqual({ recipients: ['2'], message: '1 MiXeD PING' });
    },
  );

  it('preserves variable, field, string and Unicode spelling', async () => {
    expect(
      await compile('let audience = none; let Audience = caller; ping Audience saying "PiNg"'),
    ).toEqual({ recipients: ['1'], message: 'PiNg' });
    await expect(compile('let audience = caller; ping Audience saying "hi"')).rejects.toThrow(
      'Unknown variable “Audience”',
    );
    await expect(
      compile('for person in members do ping none saying person.Name end'),
    ).rejects.toThrow('Unknown field “Name”');
    expect((await compile('let ıf = caller; ping ıf saying "hi"')).recipients).toEqual(['1']);
  });

  it('requires quotes for keyword words in names regardless of case', async () => {
    for (const name of [
      'Research and Development',
      'research AnD development',
      'if',
      'Teachers saying hello',
    ]) {
      expect(await recipients('@' + JSON.stringify(name))).toEqual(['2']);
    }
    await expect(compile('ping @Research and Development saying "hi"')).rejects.toThrow(
      'Unknown recipient',
    );
    await expect(compile('ping @if saying "hi"')).rejects.toThrow('Quote names containing syntax');
  });

  it('supports lexical scopes, assignment, loops and early PING', async () => {
    const plan = await compile(`
LET audience = NONE
LET counter = 0
FOR person IN @Teachers DO
  IF person.joinedAt != NULL THEN
    audience = audience + MEMBER(person.id)
  END
END
WHILE counter < 2 DO
  counter = counter + 1
END
IF counter == 2 AND COUNT(audience) > 0 THEN
  LET counter = 9
  PING audience SAYING "Count: " + TEXT(counter)
ELSE
  PING NONE SAYING "Nobody"
END
PING @everyone SAYING "unreachable"`);
    expect(plan).toEqual({ recipients: ['2'], message: 'Count: 9' });
    expect(
      (await compile('IF FALSE THEN PING @everyone SAYING "no" ELSE PING CALLER SAYING "yes" END'))
        .recipients,
    ).toEqual(['1']);
  });
  it('reads members and recent messages without exposing host properties', async () => {
    const plan = await compile(`LET audience = NONE
FOR message IN MESSAGES DO
  IF NOT message.bot AND CONTAINS(message.content, "class") THEN
    audience = audience + MEMBER(message.authorId)
  END
END
FOR person IN MEMBERS DO
  IF person.name == "John" THEN audience = audience + MEMBER(person.id) END
END
PING audience SAYING TEXT(COUNT(MESSAGES))`);
    expect(plan).toEqual({ recipients: ['3', '1'], message: '1' });
    await expect(
      compile('FOR person IN MEMBERS DO PING NONE SAYING person.constructor END'),
    ).rejects.toThrow('Unknown field');
    await expect(compile('PING NONE SAYING process.env')).rejects.toThrow('Unknown variable');
  });
  it('supports comments, lowercase variable names, booleans, and UTC date validation', async () => {
    expect(
      (
        await compile(
          '# comment\nLET ready = TRUE XOR FALSE; IF ready THEN PING JOINED_AFTER("2026-09-18") SAYING "yes" END',
        )
      ).recipients,
    ).toEqual(['2']);
    await expect(recipients('JOINED_AFTER("2026-02-30")')).rejects.toThrow('valid UTC date');
    expect(await recipients('JOINED_AFTER("2024-02-29")')).toEqual(['2', '3']);
    expect(
      (
        await compile(
          'IF FALSE AND missing THEN PING NONE SAYING "no" ELSE PING NONE SAYING "yes" END',
        )
      ).message,
    ).toBe('yes');
  });
});

describe('Sing diagnostics and bounds', () => {
  it('preserves source spans and suggests context names without selecting them', async () => {
    const source = 'LET audience = NONE\nPING @Teahcers SAYING "Hello"';
    try {
      await compile(source);
      expect.unreachable('Expected a diagnostic');
    } catch (error) {
      expect(error).toBeInstanceOf(SingError);
      const diagnostic = (error as SingError).diagnostic;
      expect(diagnostic.code).toBe('unknown-recipient');
      expect(source.slice(diagnostic.start, diagnostic.end)).toBe('@Teahcers');
      expect(diagnostic.suggestions).toContain('@"Teachers"');
      expect((error as Error).message).toContain('Line 2, column 6');
    }
    await expect(recipients('@Johnathan')).rejects.toThrow('Unknown recipient');
    await expect(recipients('@Nobody')).rejects.toThrow('Unknown recipient');
  });
  it.each([
    ['let LeT = none; ping LeT saying "hi"', 'reserved regardless of case'],
    ['let count = 0; ping none saying "hi"', 'reserved regardless of case'],
    ['IF TRUE THEN\nPING NONE SAYING "hi"', 'Missing END'],
    ['LET a = NONE', 'without PING'],
    ['PING NONE', 'SAYING'],
    ['PING NONE SAYING "oops', 'Unclosed string'],
    ['PING NONE SAYING "\\q"', 'Invalid string escape'],
    ['PING NONE SAYING 3', 'Expected a string'],
    ['IF @everyone THEN PING NONE SAYING "hi" END', 'Expected TRUE or FALSE'],
    ['PING @John + TRUE SAYING "hi"', 'Expected a recipient set'],
    ['LET a = 1; LET a = 2; PING NONE SAYING "hi"', 'already declared'],
    ['a = NONE; PING a SAYING "hi"', 'Declare it with LET'],
    ['IF TRUE THEN LET a = NONE END; PING a SAYING "hi"', 'Unknown variable'],
    ['PING NONE SAYING TEXT()', 'expects 1 argument'],
    ['PING NONE SAYING require("fs")', 'Unknown function'],
    ['PING NONE SAYING " "', 'message must contain'],
  ])('rejects %s with an actionable error', async (source, message) => {
    await expect(compile(source)).rejects.toThrow(message);
  });
  it.each([
    ['source larger than the limit', '#' + 'é'.repeat(limits.sourceBytes), 'too large'],
    [
      'deep nesting',
      'PING ' + '('.repeat(150) + 'NONE' + ')'.repeat(150) + ' SAYING "hi"',
      'nesting',
    ],
    ['a deep expression', `PING ${Array(150).fill('NONE').join(' + ')} SAYING "hi"`, 'too deep'],
    ['unbounded string growth', 'LET s = "x"; WHILE TRUE DO s = s + s END', 'string is too large'],
    ['an endless loop', 'WHILE TRUE DO END', /step limit|time limit/],
    [
      'a message longer than Discord allows',
      `PING NONE SAYING "${'x'.repeat(limits.messageLength + 1)}"`,
      'message must contain',
    ],
  ])('bounds %s', async (_case, source, message) => {
    await expect(compile(source)).rejects.toThrow(message);
  });

  it('bounds the audience by the shared recipient limit', async () => {
    const oversized = {
      ...context,
      members: Array.from({ length: limits.recipients + 1 }, (_, i) => ({
        id: String(i),
        name: `member ${i}`,
        roleIds: [],
        joinedAt: null,
      })),
    };
    await expect(compile('PING @everyone SAYING "hi"', oversized)).rejects.toThrow('at most');
  });

  it('stays usable after a script is refused', async () => {
    await expect(compile('WHILE TRUE DO END')).rejects.toThrow(/step limit|time limit/);
    expect(await recipients('CALLER')).toEqual(['1']);
  });
});

describe('language registry and editor', () => {
  it('pings in Sing unless another registered language is chosen', () => {
    expect(defaultLanguageId).toBe('sing');
    expect(language(defaultLanguageId).id).toBe('sing');
    expect(language('lua').id).toBe('lua');
    expect(() => language('python')).toThrow('Unknown selection language');
  });

  // The modal's custom id is how a submitted script finds its language again, so it is a contract.
  it.each([
    ['sing', 'Siren Call · Sing', 'Sing script', 'PING CALLER SAYING'],
    ['lua', 'Siren Call · Lua', 'Lua script', 'member(caller_id)'],
  ])('opens a %s editor carrying its language id', (id, title, label, starter) => {
    const modal = scriptModal(id).toJSON();
    expect(modal.custom_id).toBe(`ping:${id}`);
    expect(modal.title).toBe(title);
    const row = modal.components[0] as unknown as {
      components: { custom_id: string; label: string; value?: string }[];
    };
    const input = row.components[0]!;
    expect(input.custom_id).toBe('script');
    expect(input.label).toBe(label);
    expect(input.value).toContain(starter);
  });

  it('refuses an editor for an unregistered language', () => {
    expect(() => scriptModal('python')).toThrow('Unknown selection language');
  });
});
