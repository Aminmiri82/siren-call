import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { applicationId, guildId, token } from './config.js';

const command = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Select recipients with Lua, preview, then send.')
  .addStringOption(option =>
    option
      .setName('script')
      .setDescription(
        'Lua returning { recipients = ..., message = "..." }; omit to open an editor.',
      )
      .setMaxLength(4000),
  );
// Upsert only our command; never replace other application commands.
await new REST()
  .setToken(token())
  .post(Routes.applicationGuildCommands(applicationId, guildId), { body: command.toJSON() });
console.log(`Registered /ping in guild ${guildId}.`);
