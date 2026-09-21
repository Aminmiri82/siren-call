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
    throw new Error('Another script is still running. Try again later.');
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
      content: 'This preview has expired or was already used. Run /ping again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (saved.owner !== interaction.user.id || saved.channel !== interaction.channelId) {
    await interaction.reply({
      content: 'Only the person who ran /ping can use this preview, and only in that channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Claim before awaiting: two clicks cannot send the same preview twice.
  previews.delete(previewId);
  await interaction.deferUpdate();
  if (action === 'cancel') {
    await interaction.editReply({
      content: 'Cancelled. No messages were sent.',
      embeds: [],
      components: [],
    });
    return;
  }
  await interaction.editReply({
    content: 'Sending…',
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
      content: `**Not sent.** ${problem}\nRun /ping again once that’s fixed.`,
    });
    return;
  }
  const result = await deliver(plan, batch => state.channel.send(batch));
  const removed = saved.plan.recipients.length - plan.recipients.length;
  const people = quantity(result.sentRecipients, 'person', 'people');
  const outcome = result.complete
    ? `Pinged ${people}${result.sentMessages > 1 ? ` in ${quantity(result.sentMessages, 'message')}` : ''}.`
    : `**Delivery stopped.** ${quantity(result.sentMessages, 'message')} confirmed, reaching ${people}. The one that failed may still have gone through; nothing was retried.`;
  const skipped = removed
    ? `\nSkipped ${quantity(removed, 'person', 'people')} who can no longer see this channel.`
    : '';
  await interaction.editReply({ content: outcome + skipped });
}

/** Drop previews nobody can use any more, so a long-lived process does not accumulate them. */
export function expirePreviews() {
  for (const [key, item] of previews) if (item.expires <= Date.now()) previews.delete(key);
}
