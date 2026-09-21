import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { applicationId, guildId, token } from './config.js';

const command = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Ping people using a script. Preview first, then send.')
  .addStringOption(option =>
    option
      .setName('language')
      .setDescription('You can choose between Sing and Lua.')
      .addChoices({ name: 'Sing (default)', value: 'sing' }, { name: 'Lua', value: 'lua' }),
  )
  .addStringOption(option =>
    option
      .setName('script')
      .setDescription('A script in the selected language; omit to open the editor.')
      .setMaxLength(4000),
  );
// Upsert only our command; never replace other application commands.
await new REST()
  .setToken(token())
  .post(Routes.applicationGuildCommands(applicationId, guildId), { body: command.toJSON() });
console.log(`Registered /ping in guild ${guildId}.`);
