export const applicationId = process.env.DISCORD_APPLICATION_ID ?? '1550468456678170684';
export const guildId = process.env.DISCORD_GUILD_ID ?? '1422967166088773664';
export function token(): string {
  const value = process.env.DISCORD_TOKEN;
  if (!value) throw new Error('Set DISCORD_TOKEN in .env. See .env.example.');
  return value;
}
