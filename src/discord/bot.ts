import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, Collection, Events,
  GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction, GuildMember, GuildTextBasedChannel, ModalSubmitInteraction } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { LuaSelectionLanguage } from '../languages/lua/index.js';
import { batches, deliver, limits, permissionProblem, validatePlan } from '../selection.js';
import type { CompileContext, PingPlan, SelectionLanguage } from '../selection.js';
import { guildId, token } from './config.js';

type Interaction = ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction;
const languages = new Map<string, SelectionLanguage>([['lua', new LuaSelectionLanguage()]]);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], allowedMentions: { parse: [], repliedUser: false } });
interface Preview { owner: string; channel: string; plan: PingPlan; expires: number }
const previews = new Map<string, Preview>();
const busy = new Set<string>();
const MAX_COMPILATIONS = 4;

async function snapshot(interaction: Interaction): Promise<{ context: CompileContext; canMentionEveryone: boolean; channel: GuildTextBasedChannel; sendProblem?: string }> {
  if (!interaction.inGuild() || interaction.guildId !== guildId || !interaction.channelId) throw new Error('Use this command in the configured test server.');
  const guild = await client.guilds.fetch(interaction.guildId);
  const channel = await guild.channels.fetch(interaction.channelId, { force: true });
  if (!channel || !channel.isTextBased() || channel.isThread() || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
    throw new Error('Use /ping in a normal text or announcement channel. Threads and voice channels are not supported yet.');
  }
  // Fetch roles and members, rather than treating a partial cache as everyone.
  await guild.roles.fetch();
  // Gateway REQUEST_GUILD_MEMBERS is heavily limited even between preview/send.
  // REST pagination goes through discord.js's rate-limit queue instead.
  const members = new Collection<string, GuildMember>();
  let after: string | undefined;
  while (true) {
    const page = await guild.members.list({ limit: 1000, after });
    for (const [id, member] of page) members.set(id, member);
    if (page.size < 1000) break;
    const next = page.lastKey();
    if (!next || next === after) throw new Error('Could not fetch a complete member list. Try again.');
    after = next;
  }
  const caller = await guild.members.fetch({ user: interaction.user.id, force: true });
  const bot = await guild.members.fetchMe({ force: true });
  const callerPermissions = channel.permissionsFor(caller);
  const botPermissions = channel.permissionsFor(bot);
  const context: CompileContext = {
    callerId: caller.id,
    members: [...members.values()]
      .filter(member => !member.user.bot && channel.permissionsFor(member).has(PermissionFlagsBits.ViewChannel))
      .map(member => ({ id: member.id, name: member.displayName, username: member.user.username, globalName: member.user.globalName, roleIds: [...member.roles.cache.keys()], joinedAt: member.joinedAt?.toISOString() ?? null })),
    roles: [...guild.roles.cache.values()].map(role => ({ id: role.id, name: role.name })),
  };
  let sendProblem: string | undefined;
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (!callerPermissions.has(required) || caller.isCommunicationDisabled()) sendProblem = 'You cannot send messages in this channel.';
  else if (!botPermissions.has(required) || bot.isCommunicationDisabled()) sendProblem = 'The bot needs View Channel and Send Messages here and must not be timed out.';
  return { context, canMentionEveryone: callerPermissions.has(PermissionFlagsBits.MentionEveryone), channel, sendProblem };
}

function quantity(count: number, singular: string, plural = singular + 's') {
  return `${count} ${count === 1 ? singular : plural}`;
}

function controls(id: string, blocked: boolean) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:${id}`).setLabel('Send ping').setStyle(ButtonStyle.Primary).setDisabled(blocked),
    new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )];
}

async function preview(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, source: string) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (busy.has(interaction.user.id) || busy.size >= MAX_COMPILATIONS) throw new Error('Another script is running. Try again shortly.');
  busy.add(interaction.user.id);
  try {
    const state = await snapshot(interaction);
    const plan = validatePlan(await languages.get('lua')!.compile(source, state.context), state.context);
    const problem = state.sendProblem ?? permissionProblem(plan, state.context, state.canMentionEveryone);
    for (const [id, item] of previews) if (item.expires <= Date.now() || item.owner === interaction.user.id) previews.delete(id);
    const id = randomUUID();
    previews.set(id, { owner: interaction.user.id, channel: interaction.channelId!, plan, expires: Date.now() + limits.previewMs });
    const names = plan.recipients.slice(0, 12).map(id => state.context.members.find(member => member.id === id)!.name).join(', ');
    const description = [
      `**Ping ${quantity(plan.recipients.length, "person", "people")}?**`,
      names + (plan.recipients.length > 12 ? `, +${plan.recipients.length - 12} more` : ''),
      ...(problem ? [`\n**Can’t send:** ${problem}`] : []),
    ].join('\n');
    const count = batches(plan).length;
    await interaction.editReply({
      content: description.slice(0, 1900),
      embeds: [{ description: plan.message, footer: { text: `${count > 1 ? `${count} messages · ` : ''}Expires in 5 minutes` } }],
      components: controls(id, Boolean(problem)), allowedMentions: { parse: [] },
    });
  } finally { busy.delete(interaction.user.id); }
}

async function handleButton(interaction: ButtonInteraction) {
  const [action, id] = interaction.customId.split(':');
  if (!id || !['send', 'cancel'].includes(action!)) return;
  const saved = previews.get(id);
  if (!saved || saved.expires <= Date.now()) {
    previews.delete(id);
    await interaction.reply({ content: 'This preview expired or was already used. Run /ping again.', flags: MessageFlags.Ephemeral }); return;
  }
  if (saved.owner !== interaction.user.id || saved.channel !== interaction.channelId) {
    await interaction.reply({ content: 'Only the author can use this preview.', flags: MessageFlags.Ephemeral }); return;
  }
  // Claim before awaiting: two clicks cannot send the same preview twice.
  previews.delete(id);
  await interaction.deferUpdate();
  if (action === 'cancel') {
    await interaction.editReply({ content: 'Cancelled. No messages sent.', embeds: [], components: [] }); return;
  }
  await interaction.editReply({ content: 'Checking current permissions and recipients…', embeds: [], components: [] });
  const state = await snapshot(interaction);
  const eligible = new Set(state.context.members.map(member => member.id));
  const plan = { ...saved.plan, recipients: saved.plan.recipients.filter(id => eligible.has(id)) };
  const problem = state.sendProblem ?? permissionProblem(plan, state.context, state.canMentionEveryone);
  if (problem) {
    await interaction.editReply({ content: `Cannot send: ${problem}\nRun /ping again after resolving it.` }); return;
  }
  const result = await deliver(plan, batch => state.channel.send(batch));
  const removed = saved.plan.recipients.length - plan.recipients.length;
  const outcome = result.complete
    ? `Sent ${quantity(result.sentMessages, "message")} mentioning ${quantity(result.sentRecipients, "person", "people")}.`
    : `Delivery stopped after ${result.sentMessages} confirmed messages (${result.sentRecipients} recipients). The failed request may have reached Discord; nothing was retried automatically.`;
  await interaction.editReply({ content: outcome + (removed ? `\nSkipped ${removed} recipients who are no longer eligible.` : '') });
}

client.on(Events.InteractionCreate, async interaction => {
  if (!(interaction.isChatInputCommand() || interaction.isModalSubmit() || interaction.isButton())) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      const source = interaction.options.getString('script');
      if (source) await preview(interaction, source);
      else {
        const input = new TextInputBuilder().setCustomId('script').setLabel('Lua script').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)
          .setValue('return {\n  recipients = member(caller_id),\n  message = "The siren calls!"\n}');
        await interaction.showModal(new ModalBuilder().setCustomId('ping:lua').setTitle('Siren Call · Lua').addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
      }
    } else if (interaction.isModalSubmit() && interaction.customId === 'ping:lua') await preview(interaction, interaction.fields.getTextInputValue('script'));
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (error) {
    const content = `**Couldn’t prepare this ping.**\n${error instanceof Error ? error.message.slice(0, 1700) : 'Please try again.'}`;
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch { console.error('Could not deliver interaction error response.'); }
  }
});
client.once(Events.ClientReady, ready => console.log(`Siren Call ready as ${ready.user.tag}; test guild ${guildId}.`));
client.on(Events.Error, error => console.error('Discord client error:', error.message));
setInterval(() => { for (const [id, item] of previews) if (item.expires <= Date.now()) previews.delete(id); }, 60_000).unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { client.destroy(); process.exit(0); });
await client.login(token());
