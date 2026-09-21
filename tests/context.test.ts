import { expect, it } from 'vitest';
import { ChannelType } from 'discord.js';
import type { GuildMember, GuildTextBasedChannel, Role } from 'discord.js';
import { GUILD_ID, createGuild, createInteraction } from './fake-discord.js';

process.env.DISCORD_GUILD_ID = GUILD_ID;
const { snapshot, toCompileContext } = await import('../dist/discord/context.js');

const channel = {
  permissionsFor: (member: { id: string }) => ({ has: () => member.id !== 'hidden' }),
} as unknown as GuildTextBasedChannel;

function guildMembers() {
  const members = ['online', 'idle', 'dnd', 'offline', 'invisible', undefined].map(
    (status, index) => ({
      id: String(index),
      displayName: `Member ${index}`,
      user: { bot: false, username: `member${index}`, globalName: null },
      roles: { cache: new Map() },
      joinedAt: null,
      presence: status ? { status } : null,
    }),
  );
  const bot = { ...members[0]!, id: 'bot', user: { ...members[0]!.user, bot: true } };
  const hidden = { ...members[0]!, id: 'hidden' };
  return [...members, bot, hidden] as unknown as GuildMember[];
}

it('excludes bots and members who cannot view the channel', () => {
  const context = toCompileContext(guildMembers(), [], [], channel, '0', true);
  expect(context.members.map(member => member.id)).toEqual(['0', '1', '2', '3', '4', '5']);
});

it('maps invisible to offline and reports unknown presence as offline', () => {
  const context = toCompileContext(guildMembers(), [], [], channel, '0', true);
  expect(context.presenceAvailable).toBe(true);
  expect(context.members.map(member => member.presence)).toEqual([
    'online',
    'idle',
    'dnd',
    'offline',
    'offline',
    'offline',
  ]);
});

it('withholds presence entirely when the intent is unavailable, rather than guessing', () => {
  const context = toCompileContext(guildMembers(), [], [], channel, '0');
  expect(context.presenceAvailable).toBe(false);
  expect(context.members.every(member => member.presence === null)).toBe(true);
});

it('copies the name aliases, roles and join date that selection depends on', () => {
  const member = {
    id: '7',
    displayName: 'Zoë',
    user: { bot: false, username: 'zoe42', globalName: 'Zoë Fairweather' },
    roles: { cache: new Map([['10', {}]]) },
    joinedAt: new Date('2026-09-01T00:00:00.000Z'),
    presence: null,
  } as unknown as GuildMember;
  const roles = [{ id: '10', name: 'Teachers' }] as unknown as Role[];
  const context = toCompileContext([member], roles, [], channel, '7');
  expect(context.members).toEqual([
    {
      id: '7',
      name: 'Zoë',
      username: 'zoe42',
      globalName: 'Zoë Fairweather',
      roleIds: ['10'],
      joinedAt: '2026-09-01T00:00:00.000Z',
      presence: null,
    },
  ]);
  expect(context.roles).toEqual([{ id: '10', name: 'Teachers' }]);
  expect(context.callerId).toBe('7');
});

it('hands scripts an oldest-first transcript of the channel', async () => {
  const guild = createGuild({
    messages: [
      {
        id: '1',
        authorId: '2',
        authorName: 'Ana',
        content: 'first',
        createdAt: '2026-09-19T09:00:00.000Z',
      },
      {
        id: '2',
        authorId: '3',
        authorName: 'Bo',
        bot: true,
        content: 'second',
        createdAt: '2026-09-19T09:01:00.000Z',
      },
    ],
  });
  const { interaction } = createInteraction(guild, { userId: '1' });
  const state = await snapshot(interaction);
  expect(state.context.messages.map(message => message.content)).toEqual(['first', 'second']);
  expect(state.context.messages.map(message => message.bot)).toEqual([false, true]);
});

it('never blocks a ping on unreadable message history', async () => {
  const guild = createGuild({ messages: 'unreadable' });
  const { interaction } = createInteraction(guild, { userId: '1' });
  const state = await snapshot(interaction);
  expect(state.context.messages).toEqual([]);
  expect(state.sendProblem).toBeUndefined();
});

it('names who is blocked when the author or the bot cannot send here', async () => {
  const guild = createGuild();
  guild.members[0]!.canSend = false;
  const author = createInteraction(guild, { userId: '1' });
  expect((await snapshot(author.interaction)).sendProblem).toContain('You can’t send messages');
  guild.members[0]!.canSend = true;
  guild.bot.canView = false;
  expect((await snapshot(author.interaction)).sendProblem).toContain('Siren Call can’t send');
});

it('reports Mention Everyone from the author’s channel permissions', async () => {
  const guild = createGuild();
  const author = createInteraction(guild, { userId: '1' });
  expect((await snapshot(author.interaction)).canMentionEveryone).toBe(false);
  guild.members[0]!.canMentionEveryone = true;
  expect((await snapshot(author.interaction)).canMentionEveryone).toBe(true);
});

it.each([
  ['a thread', createGuild({ channelType: ChannelType.PublicThread }), {}],
  ['a channel it cannot fetch', createGuild(), { channelId: 'somewhere-else' }],
])('refuses to build a plan for %s', async (_case, guild, options) => {
  const { interaction } = createInteraction(guild, { userId: '1', ...options });
  await expect(snapshot(interaction)).rejects.toThrow('not threads or voice');
});

it('refuses any guild but the configured one', async () => {
  const { interaction } = createInteraction(createGuild(), { userId: '1', guildId: 'elsewhere' });
  await expect(snapshot(interaction)).rejects.toThrow('isn’t set up for this server');
});
