import { MessageFlags } from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { language } from '../languages/index.js';
import { deliver, limits, permissionProblem, validatePlan } from '../selection.js';
import type { PingPlan } from '../selection.js';
import { snapshot } from './context.js';
import { previewMessage, quantity } from './ui.js';

const MAX_COMPILATIONS = 4;

interface Preview {
  owner: string;
  channel: string;
  plan: PingPlan;
  expires: number;
}

const previews = new Map<string, Preview>();
const busy = new Set<string>();

export async function preview(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  languageId: string,
  source: string,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (busy.has(interaction.user.id) || busy.size >= MAX_COMPILATIONS) {
    throw new Error('Another script is running. Try again shortly.');
  }
  busy.add(interaction.user.id);
  try {
    const state = await snapshot(interaction);
    const compiled = await language(languageId).compile(source, state.context);
    const plan = validatePlan(compiled, state.context);
    const problem =
      state.sendProblem ?? permissionProblem(plan, state.context, state.canMentionEveryone);
    for (const [key, item] of previews) {
      if (item.expires <= Date.now() || item.owner === interaction.user.id) previews.delete(key);
    }
    const previewId = randomUUID();
    previews.set(previewId, {
      owner: interaction.user.id,
      channel: state.channel.id,
      plan,
      expires: Date.now() + limits.previewMs,
    });
    await interaction.editReply(previewMessage(previewId, plan, state.context, problem));
  } finally {
    busy.delete(interaction.user.id);
  }
}

export async function handleButton(interaction: ButtonInteraction) {
  const [action, previewId] = interaction.customId.split(':');
  if (!previewId || !['send', 'cancel'].includes(action!)) return;
  const saved = previews.get(previewId);
  if (!saved || saved.expires <= Date.now()) {
    previews.delete(previewId);
    await interaction.reply({
      content: 'This preview expired or was already used. Run /ping again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (saved.owner !== interaction.user.id || saved.channel !== interaction.channelId) {
    await interaction.reply({
      content: 'Only the author can use this preview.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Claim before awaiting: two clicks cannot send the same preview twice.
  previews.delete(previewId);
  await interaction.deferUpdate();
  if (action === 'cancel') {
    await interaction.editReply({
      content: 'Cancelled. No messages sent.',
      embeds: [],
      components: [],
    });
    return;
  }
  await interaction.editReply({
    content: 'Checking current permissions and recipients…',
    embeds: [],
    components: [],
  });
  const state = await snapshot(interaction);
  const eligible = new Set(state.context.members.map(member => member.id));
  const plan = { ...saved.plan, recipients: saved.plan.recipients.filter(id => eligible.has(id)) };
  const problem =
    state.sendProblem ?? permissionProblem(plan, state.context, state.canMentionEveryone);
  if (problem) {
    await interaction.editReply({
      content: `Cannot send: ${problem}\nRun /ping again after resolving it.`,
    });
    return;
  }
  const result = await deliver(plan, batch => state.channel.send(batch));
  const removed = saved.plan.recipients.length - plan.recipients.length;
  const outcome = result.complete
    ? `Sent ${quantity(result.sentMessages, 'message')} mentioning ${quantity(result.sentRecipients, 'person', 'people')}.`
    : `Delivery stopped after ${result.sentMessages} confirmed messages (${result.sentRecipients} recipients). The failed request may have reached Discord; nothing was retried automatically.`;
  const skipped = removed ? `\nSkipped ${removed} recipients who are no longer eligible.` : '';
  await interaction.editReply({ content: outcome + skipped });
}

/** Drop previews nobody can use any more, so a long-lived process does not accumulate them. */
export function expirePreviews() {
  for (const [key, item] of previews) if (item.expires <= Date.now()) previews.delete(key);
}
