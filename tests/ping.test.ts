import { afterEach, expect, it, vi } from 'vitest';
import type { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { CHANNEL_ID, GUILD_ID, createGuild, createInteraction } from './fake-discord.js';
import type { FakeGuild } from './fake-discord.js';

// `snapshot` refuses any guild but the configured one, so the fake guild has to be that guild
// before the Discord layer reads its configuration.
process.env.DISCORD_GUILD_ID = GUILD_ID;
const { handleButton, preview } = await import('../dist/discord/ping.js');
const { limits } = await import('../dist/selection.js');

interface Button {
  custom_id: string;
  label: string;
  disabled?: boolean;
}

function buttons(payload: Record<string, unknown>): Button[] {
  const rows = payload.components as ActionRowBuilder<ButtonBuilder>[];
  return rows[0]!.toJSON().components as unknown as Button[];
}

/** Run the preview flow as `userId` and hand back what the author was shown. */
async function showPreview(guild: FakeGuild, userId: string, source: string) {
  const author = createInteraction(guild, { userId });
  await preview(author.interaction, 'sing', source);
  const payload = author.latest();
  const [send, cancel] = buttons(payload);
  return { payload, send: send!, cancel: cancel! };
}

async function click(guild: FakeGuild, userId: string, customId: string, channelId = CHANNEL_ID) {
  const clicker = createInteraction(guild, { userId, customId, channelId });
  await handleButton(clicker.interaction);
  return clicker;
}

afterEach(() => vi.restoreAllMocks());

it('previews a plan without pinging anyone and withholds a send it cannot make', async () => {
  const guild = createGuild();
  const { payload, send, cancel } = await showPreview(guild, '1', 'PING @everyone SAYING "Hello"');
  expect(payload.allowedMentions).toEqual({ parse: [] });
  expect(payload.content).toContain('Ping 3 people?');
  expect(payload.content).toContain('Yara, Ana, Bo');
  // The author cannot mention everyone, so the whole channel is a plan they may not send.
  expect(payload.content).toContain('Mention Everyone');
  expect(send.disabled).toBe(true);
  expect(cancel.disabled).toBeFalsy();
  expect(guild.sent).toEqual([]);
});

it('sends exactly the previewed recipients as user mentions', async () => {
  const guild = createGuild();
  const { payload, send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  expect(send.disabled).toBeFalsy();
  const clicker = await click(guild, '1', send.custom_id);
  expect(guild.sent).toHaveLength(1);
  const batch = guild.sent[0]!;
  expect(batch.allowedMentions).toEqual({ parse: [], users: ['1', '2'], repliedUser: false });
  expect(batch.content).toBe('Roll call\n\n<@1> <@2>');
  expect(clicker.latest().content).toBe('Pinged 2 people.');
  expect(payload.content).toContain('Ping 2 people?');
});

it('refuses a preview clicked by another member or from another channel', async () => {
  const guild = createGuild();
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  const stranger = await click(guild, '2', send.custom_id);
  expect(stranger.latest().content).toContain('Only the person who ran /ping');
  const elsewhere = await click(guild, '1', send.custom_id, 'other-channel');
  expect(elsewhere.latest().content).toContain('Only the person who ran /ping');
  expect(guild.sent).toEqual([]);
  // A rejected click does not consume the preview, so the author can still send it.
  await click(guild, '1', send.custom_id);
  expect(guild.sent).toHaveLength(1);
});

it('expires a preview once the preview window closes', async () => {
  const guild = createGuild();
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + limits.previewMs + 1);
  const clicker = await click(guild, '1', send.custom_id);
  expect(clicker.latest().content).toContain('expired');
  expect(guild.sent).toEqual([]);
});

it('cancels a preview without sending anything', async () => {
  const guild = createGuild();
  const { send, cancel } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  const clicker = await click(guild, '1', cancel.custom_id);
  expect(clicker.latest()).toMatchObject({ content: 'Cancelled. No messages were sent.' });
  expect(guild.sent).toEqual([]);
  // Cancelling consumes the preview: the send button cannot resurrect it.
  const retry = await click(guild, '1', send.custom_id);
  expect(retry.latest().content).toContain('expired or was already used');
  expect(guild.sent).toEqual([]);
});

it('sends once when the same preview is clicked twice', async () => {
  const guild = createGuild();
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  const first = createInteraction(guild, { userId: '1', customId: send.custom_id });
  const second = createInteraction(guild, { userId: '1', customId: send.custom_id });
  await Promise.all([handleButton(first.interaction), handleButton(second.interaction)]);
  expect(guild.sent).toHaveLength(1);
  const outcomes = [first.latest().content, second.latest().content];
  expect(outcomes).toContain('Pinged 2 people.');
  expect(outcomes.some(content => String(content).includes('already used'))).toBe(true);
});

it('re-checks permissions at send time and refuses when the author lost them', async () => {
  const guild = createGuild();
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  guild.members[0]!.canSend = false;
  const clicker = await click(guild, '1', send.custom_id);
  expect(clicker.latest().content).toContain('**Not sent.** You can’t send messages');
  expect(guild.sent).toEqual([]);
});

it('refuses to send when the bot was timed out after the preview', async () => {
  const guild = createGuild();
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  guild.bot.timedOut = true;
  const clicker = await click(guild, '1', send.custom_id);
  expect(clicker.latest().content).toContain('**Not sent.** Siren Call can’t send');
  expect(guild.sent).toEqual([]);
});

it('drops recipients who became ineligible without adding new matches', async () => {
  const guild = createGuild();
  guild.members[0]!.canMentionEveryone = true;
  const { send } = await showPreview(guild, '1', 'PING @everyone SAYING "Hello"');
  guild.members = [
    guild.members[0]!,
    guild.members[1]!,
    { id: '4', name: 'Newcomer', roleIds: [] },
  ];
  const clicker = await click(guild, '1', send.custom_id);
  expect(guild.sent).toHaveLength(1);
  expect(guild.sent[0]!.allowedMentions.users).toEqual(['1', '2']);
  expect(guild.sent[0]!.content).not.toContain('<@4>');
  expect(clicker.latest().content).toContain(
    'Skipped 1 person who can no longer see this channel.',
  );
});

it('reports a stopped delivery instead of claiming success', async () => {
  const guild = createGuild({ failSendAt: 1 });
  const { send } = await showPreview(guild, '1', 'PING @Teachers SAYING "Roll call"');
  const clicker = await click(guild, '1', send.custom_id);
  expect(guild.sent).toEqual([]);
  const content = String(clicker.latest().content);
  expect(content).toContain('Delivery stopped.** 0 messages confirmed');
  expect(content).toContain('nothing was retried');
});

it('retires an author’s earlier preview when they preview again', async () => {
  const guild = createGuild();
  const first = await showPreview(guild, '1', 'PING @Teachers SAYING "First"');
  const second = await showPreview(guild, '1', 'PING CALLER SAYING "Second"');
  const stale = await click(guild, '1', first.send.custom_id);
  expect(stale.latest().content).toContain('expired or was already used');
  await click(guild, '1', second.send.custom_id);
  expect(guild.sent.map(batch => batch.content)).toEqual(['Second\n\n<@1>']);
});

it('refuses a second concurrent script from the same author', async () => {
  const guild = createGuild();
  const source = 'PING @Teachers SAYING "Roll call"';
  const first = createInteraction(guild, { userId: '1' });
  const second = createInteraction(guild, { userId: '1' });
  const results = await Promise.allSettled([
    preview(first.interaction, 'sing', source),
    preview(second.interaction, 'sing', source),
  ]);
  const rejected = results.filter(result => result.status === 'rejected');
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason.message).toContain(
    'Another script is still running',
  );
});
