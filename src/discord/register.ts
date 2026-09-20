import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { applicationId, guildId, token } from './config.js';

const command = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Select recipients with Lua or Sing, preview, then send.')
  .addStringOption(option =>
    option
      .setName('language')
      .setDescription('Selection language (default: Lua).')
      .addChoices({ name: 'Lua', value: 'lua' }, { name: 'Sing', value: 'sing' }),
  )
  .addStringOption(option =>
    option
      .setName('script')
      .setDescription('A script in the selected language; omit to open an editor.')
      .setMaxLength(4000),
  );
// Upsert only our command; never replace other application commands.
await new REST()
  .setToken(token())
  .post(Routes.applicationGuildCommands(applicationId, guildId), { body: command.toJSON() });
console.log(`Registered /ping in guild ${guildId}.`);
