import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { defaultLanguageId } from '../languages/index.js';
import { guildId, token } from './config.js';
import { expirePreviews, handleButton, preview } from './ping.js';
import { scriptModal } from './ui.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  allowedMentions: { parse: [], repliedUser: false },
});

client.on(Events.InteractionCreate, async interaction => {
  if (!(
    interaction.isChatInputCommand() ||
    interaction.isModalSubmit() ||
    interaction.isButton()
  )) {
    return;
  }
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
      const source = interaction.options.getString('script');
      const languageId = interaction.options.getString('language') ?? defaultLanguageId;
      if (source) await preview(interaction, languageId, source);
      else await interaction.showModal(scriptModal(languageId));
    } else if (interaction.isModalSubmit() && interaction.customId.startsWith('ping:')) {
      const languageId = interaction.customId.slice('ping:'.length);
      await preview(interaction, languageId, interaction.fields.getTextInputValue('script'));
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1700) : 'Please try again.';
    const content = `**Couldn’t prepare this ping.**\n${detail}`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content,
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
      } else {
        await interaction.reply({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }
    } catch {
      console.error('Could not deliver interaction error response.');
    }
  }
});

client.once(Events.ClientReady, ready =>
  console.log(`Siren Call ready as ${ready.user.tag}; test guild ${guildId}.`),
);
client.on(Events.Error, error => console.error('Discord client error:', error.message));
setInterval(expirePreviews, 60_000).unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    client.destroy();
    process.exit(0);
  });
}
await client.login(token());
