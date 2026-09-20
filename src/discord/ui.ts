import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { InteractionEditReplyOptions } from 'discord.js';
import { language } from '../languages/index.js';
import { batches } from '../selection.js';
import type { CompileContext, PingPlan } from '../selection.js';

const PREVIEW_NAMES = 12;

export function quantity(count: number, singular: string, plural = singular + 's') {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function scriptModal(languageId: string) {
  language(languageId);
  const sing = languageId === 'sing';
  const label = sing ? 'Sing' : 'Lua';
  const input = new TextInputBuilder()
    .setCustomId('script')
    .setLabel(`${label} script`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setValue(
      sing
        ? 'PING CALLER SAYING "The siren calls!"'
        : 'return {\n  recipients = member(caller_id),\n  message = "The siren calls!"\n}',
    );
  return new ModalBuilder()
    .setCustomId(`ping:${languageId}`)
    .setTitle(`Siren Call · ${label}`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function previewMessage(
  previewId: string,
  plan: PingPlan,
  context: CompileContext,
  problem: string | undefined,
): InteractionEditReplyOptions {
  const shown = plan.recipients.slice(0, PREVIEW_NAMES);
  const extra = plan.recipients.length - shown.length;
  const names = shown.map(id => context.members.find(member => member.id === id)!.name).join(', ');
  const description = [
    `**Ping ${quantity(plan.recipients.length, 'person', 'people')}?**`,
    names + (extra ? `, +${extra} more` : ''),
    ...(problem ? [`\n**Can’t send:** ${problem}`] : []),
  ].join('\n');
  const count = batches(plan).length;
  return {
    content: description.slice(0, 1900),
    embeds: [
      {
        description: plan.message,
        footer: { text: `${count > 1 ? `${count} messages · ` : ''}Expires in 5 minutes` },
      },
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`send:${previewId}`)
          .setLabel('Send ping')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(Boolean(problem)),
        new ButtonBuilder()
          .setCustomId(`cancel:${previewId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}
