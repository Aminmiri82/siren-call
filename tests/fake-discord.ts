import { ChannelType, Collection } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  GuildTextBasedChannel,
} from 'discord.js';
import type { PingBatch } from '../dist/selection.js';

/**
 * A controllable stand-in for the one true external boundary: the Discord gateway and REST API.
 * Everything the bot decides — eligibility, permissions, ownership, delivery — stays real, and
 * `sent` is the only way a message leaves, so tests can assert what Discord would have received.
 */
export const GUILD_ID = 'guild-1';
export const CHANNEL_ID = 'channel-1';
export const BOT_ID = 'bot-1';

export interface MemberSpec {
  id: string;
  name: string;
  username?: string;
  globalName?: string | null;
  roleIds?: string[];
  joinedAt?: string | null;
  presence?: 'online' | 'idle' | 'dnd' | 'offline' | 'invisible' | null;
  bot?: boolean;
  /** Channel permissions, mutable so a test can revoke one between preview and send. */
  canView?: boolean;
  canSend?: boolean;
  canMentionEveryone?: boolean;
  timedOut?: boolean;
}

export interface MessageSpec {
  id: string;
  authorId: string;
  authorName: string;
  bot?: boolean;
  content: string;
  createdAt: string;
}

export interface FakeGuild {
  members: MemberSpec[];
  roles: { id: string; name: string }[];
  /** `'unreadable'` models a missing Message Content intent or Read Message History. */
  messages: MessageSpec[] | 'unreadable';
  bot: MemberSpec;
  presenceIntent: boolean;
  channelType: ChannelType;
  /** Batches Discord accepted, in order. */
  sent: PingBatch[];
  /** 1-based batch number that fails, modelling an outage mid-delivery. */
  failSendAt?: number;
}

export function createGuild(overrides: Partial<FakeGuild> = {}): FakeGuild {
  return {
    members: [
      { id: '1', name: 'Yara', roleIds: ['10'] },
      { id: '2', name: 'Ana', roleIds: ['10'] },
      { id: '3', name: 'Bo', roleIds: [] },
    ],
    roles: [{ id: '10', name: 'Teachers' }],
    messages: [],
    bot: { id: BOT_ID, name: 'Siren Call', bot: true },
    presenceIntent: false,
    channelType: ChannelType.GuildText,
    sent: [],
    ...overrides,
  };
}

function memberObject(spec: MemberSpec) {
  return {
    id: spec.id,
    displayName: spec.name,
    user: {
      bot: spec.bot ?? false,
      username: spec.username ?? spec.name,
      globalName: spec.globalName ?? null,
      displayName: spec.name,
    },
    roles: { cache: new Map((spec.roleIds ?? []).map(id => [id, { id }])) },
    joinedAt: spec.joinedAt ? new Date(spec.joinedAt) : null,
    presence: spec.presence ? { status: spec.presence } : null,
    isCommunicationDisabled: () => spec.timedOut ?? false,
  };
}

function permissionsFor(guild: FakeGuild, member: { id: string }) {
  const spec = [...guild.members, guild.bot].find(candidate => candidate.id === member.id);
  const allowed = new Map<bigint, boolean>([
    [PermissionFlagsBits.ViewChannel, spec?.canView ?? true],
    [PermissionFlagsBits.SendMessages, spec?.canSend ?? true],
    [PermissionFlagsBits.MentionEveryone, spec?.canMentionEveryone ?? false],
  ]);
  return {
    has: (flags: bigint | bigint[]) =>
      (Array.isArray(flags) ? flags : [flags]).every(flag => allowed.get(flag) ?? false),
  };
}

function channelObject(guild: FakeGuild) {
  return {
    id: CHANNEL_ID,
    type: guild.channelType,
    isTextBased: () => guild.channelType !== ChannelType.GuildCategory,
    isThread: () =>
      guild.channelType === ChannelType.PublicThread ||
      guild.channelType === ChannelType.PrivateThread,
    permissionsFor: (member: { id: string }) => permissionsFor(guild, member),
    messages: {
      fetch: async () => {
        if (guild.messages === 'unreadable') throw new Error('Missing Access');
        // Discord returns newest first; the bot is responsible for the transcript order.
        return new Collection(
          guild.messages.toReversed().map(message => [
            message.id,
            {
              id: message.id,
              author: {
                id: message.authorId,
                displayName: message.authorName,
                bot: message.bot ?? false,
              },
              member: { displayName: message.authorName },
              content: message.content,
              createdTimestamp: Date.parse(message.createdAt),
            },
          ]),
        );
      },
    },
    send: async (batch: PingBatch) => {
      if (guild.failSendAt === guild.sent.length + 1) throw new Error('Discord unavailable');
      guild.sent.push(batch);
      return { id: `message-${guild.sent.length}` };
    },
  } as unknown as GuildTextBasedChannel;
}

/** Usable wherever the bot takes an interaction, so one fake covers /ping and its buttons. */
type AnyInteraction = ChatInputCommandInteraction & ButtonInteraction;

export interface FakeInteraction {
  interaction: AnyInteraction;
  /** Every reply the bot attempted, in order, including the ephemeral defers. */
  calls: { method: string; payload?: Record<string, unknown> }[];
  /** Payload of the most recent reply or edit, i.e. what the author finally sees. */
  latest(): Record<string, unknown>;
}

export function createInteraction(
  guild: FakeGuild,
  options: { userId: string; customId?: string; channelId?: string; guildId?: string },
): FakeInteraction {
  const calls: FakeInteraction['calls'] = [];
  const record = (method: string) => async (payload?: Record<string, unknown>) => {
    calls.push({ method, payload });
  };
  const member = guild.members.find(candidate => candidate.id === options.userId);
  const interaction = {
    user: { id: options.userId },
    customId: options.customId ?? '',
    guildId: options.guildId ?? GUILD_ID,
    channelId: options.channelId ?? CHANNEL_ID,
    inGuild: () => true,
    deferReply: record('deferReply'),
    deferUpdate: record('deferUpdate'),
    reply: record('reply'),
    editReply: record('editReply'),
    client: {
      isReady: () => true,
      options: { intents: { has: () => guild.presenceIntent } },
      guilds: {
        fetch: async () => ({
          available: true,
          memberCount: guild.members.length,
          roles: { fetch: async () => undefined, cache: { values: () => guild.roles.values() } },
          channels: {
            fetch: async (id: string) => (id === CHANNEL_ID ? channelObject(guild) : null),
          },
          members: {
            list: async () =>
              new Collection(guild.members.map(spec => [spec.id, memberObject(spec)])),
            fetch: async () => {
              if (!member) throw new Error(`Unknown member ${options.userId}`);
              return memberObject(member);
            },
            fetchMe: async () => memberObject(guild.bot),
          },
        }),
      },
    },
  } as unknown as AnyInteraction;
  return {
    interaction,
    calls,
    latest: () => calls.at(-1)?.payload ?? {},
  };
}
