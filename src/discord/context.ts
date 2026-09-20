import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  ModalSubmitInteraction,
  Role,
} from 'discord.js';
import type { CompileContext } from '../selection.js';
import { guildId } from './config.js';

export type Interaction = ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction;

export interface ChannelSnapshot {
  context: CompileContext;
  channel: GuildTextBasedChannel;
  canMentionEveryone: boolean;
  sendProblem?: string;
}

// Gateway REQUEST_GUILD_MEMBERS is heavily limited even between preview and send.
// REST pagination goes through discord.js's rate-limit queue instead.
async function listMembers(guild: Guild): Promise<Collection<string, GuildMember>> {
  const members = new Collection<string, GuildMember>();
  let after: string | undefined;
  for (;;) {
    const page = await guild.members.list({ limit: 1000, after });
    for (const [id, member] of page) members.set(id, member);
    if (page.size < 1000) return members;
    const next = page.lastKey();
    if (!next || next === after)
      throw new Error('Could not fetch a complete member list. Try again.');
    after = next;
  }
}

/** Discord objects in, plain snapshots out. Adapters never see anything richer than this. */
export function toCompileContext(
  members: Iterable<GuildMember>,
  roles: Iterable<Role>,
  channel: GuildTextBasedChannel,
  callerId: string,
): CompileContext {
  return {
    callerId,
    members: [...members]
      .filter(
        member =>
          !member.user.bot && channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel),
      )
      .map(member => ({
        id: member.id,
        name: member.displayName,
        username: member.user.username,
        globalName: member.user.globalName,
        roleIds: [...member.roles.cache.keys()],
        joinedAt: member.joinedAt?.toISOString() ?? null,
      })),
    roles: [...roles].map(role => ({ id: role.id, name: role.name })),
  };
}

export async function snapshot(interaction: Interaction): Promise<ChannelSnapshot> {
  if (!interaction.inGuild() || interaction.guildId !== guildId || !interaction.channelId) {
    throw new Error('Use this command in the configured test server.');
  }
  const guild = await interaction.client.guilds.fetch(interaction.guildId);
  const channel = await guild.channels.fetch(interaction.channelId, { force: true });
  if (
    !channel ||
    !channel.isTextBased() ||
    channel.isThread() ||
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice
  ) {
    throw new Error(
      'Use /ping in a normal text or announcement channel. Threads and voice channels are not supported yet.',
    );
  }
  // Fetch roles and members, rather than treating a partial cache as everyone.
  await guild.roles.fetch();
  const members = await listMembers(guild);
  const caller = await guild.members.fetch({ user: interaction.user.id, force: true });
  const bot = await guild.members.fetchMe({ force: true });
  const callerPermissions = channel.permissionsFor(caller);
  const botPermissions = channel.permissionsFor(bot);

  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  let sendProblem: string | undefined;
  if (!callerPermissions.has(required) || caller.isCommunicationDisabled()) {
    sendProblem = 'You cannot send messages in this channel.';
  } else if (!botPermissions.has(required) || bot.isCommunicationDisabled()) {
    sendProblem = 'The bot needs View Channel and Send Messages here and must not be timed out.';
  }
  return {
    context: toCompileContext(members.values(), guild.roles.cache.values(), channel, caller.id),
    channel,
    canMentionEveryone: callerPermissions.has(PermissionFlagsBits.MentionEveryone),
    sendProblem,
  };
}
