import { expect, it } from 'vitest';
import type { GuildMember, GuildTextBasedChannel, Role } from 'discord.js';
import { toCompileContext } from '../dist/discord/context.js';

it('copies presence to plain snapshots while excluding bots and inaccessible members', () => {
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
  const channel = {
    permissionsFor: (member: { id: string }) => ({ has: () => member.id !== 'hidden' }),
  } as unknown as GuildTextBasedChannel;
  const input = [...members, bot, hidden] as unknown as GuildMember[];
  const roles: Role[] = [];
  const available = toCompileContext(input, roles, [], channel, '0', true);
  expect(available.presenceAvailable).toBe(true);
  expect(available.members.map(member => member.id)).toEqual(['0', '1', '2', '3', '4', '5']);
  expect(available.members.map(member => member.presence)).toEqual([
    'online',
    'idle',
    'dnd',
    'offline',
    'offline',
    'offline',
  ]);
  const unavailable = toCompileContext(input, roles, [], channel, '0');
  expect(unavailable.presenceAvailable).toBe(false);
  expect(unavailable.members.every(member => member.presence === null)).toBe(true);
});
