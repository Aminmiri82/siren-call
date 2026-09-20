/** The whole surface a language adapter sees: plain data in, plain data out, no Discord objects. */
export interface SelectionLanguage {
  readonly id: string;
  compile(source: string, context: CompileContext): Promise<PingPlan>;
}

export interface Member {
  id: string;
  name: string;
  username?: string;
  globalName?: string | null;
  roleIds: string[];
  joinedAt: string | null;
}

/** A message already visible in the channel to anyone who can run `/ping` there. */
export interface ChannelMessage {
  id: string;
  authorId: string;
  authorName: string;
  bot: boolean;
  content: string;
  createdAt: string;
}

export interface CompileContext {
  members: Member[];
  roles: { id: string; name: string }[];
  callerId: string;
  /** Oldest first, so an adapter can hand it to something that expects a transcript. */
  messages: ChannelMessage[];
}

export interface PingPlan {
  recipients: string[];
  message: string;
}

export const limits = {
  sourceBytes: 16_000,
  messageLength: 1_500,
  /** Loose byte guard inside Lua; `messageLength` in UTF-16 units is the authoritative check. */
  messageBytes: 6_000,
  recipients: 5_000,
  contextMessages: 10,
  /** Discord's own non-Nitro message cap, so this truncates almost nothing in practice. */
  contextMessageChars: 2_000,
  luaMemoryBytes: 16 * 1024 * 1024,
  executionMs: 2_000,
  startupMs: 10_000,
  previewMs: 5 * 60_000,
} as const;

const DISCORD_MESSAGE_LENGTH = 2_000;
const DISCORD_MENTIONS_PER_MESSAGE = 100;

/** Validate every adapter at the application boundary, not just Lua. */
export function validatePlan(value: unknown, context: CompileContext): PingPlan {
  if (!value || typeof value !== 'object') {
    throw new Error('Return a ping with recipients and a message.');
  }
  const plan = value as Partial<PingPlan>;
  if (
    typeof plan.message !== 'string' ||
    !plan.message.trim() ||
    plan.message.length > limits.messageLength
  ) {
    throw new Error(`The message must contain 1–${limits.messageLength} characters.`);
  }
  if (!Array.isArray(plan.recipients) || plan.recipients.length > limits.recipients) {
    throw new Error(`Return an array of at most ${limits.recipients} recipient IDs.`);
  }
  const eligible = new Set(context.members.map(member => member.id));
  for (const id of plan.recipients) {
    if (typeof id !== 'string' || !eligible.has(id)) {
      throw new Error(`Unknown or ineligible recipient: ${String(id).slice(0, 50)}`);
    }
  }
  return { recipients: [...new Set(plan.recipients)], message: plan.message };
}

export function permissionProblem(
  plan: PingPlan,
  context: CompileContext,
  canMentionEveryone: boolean,
): string | undefined {
  if (!plan.recipients.length) return 'No eligible recipients matched.';
  const selected = new Set(plan.recipients);
  if (!canMentionEveryone && context.members.every(member => selected.has(member.id))) {
    return 'This selects everyone who can view this channel. You need Mention Everyone in this channel to send it.';
  }
}

export interface PingBatch {
  content: string;
  allowedMentions: { parse: []; users: string[]; repliedUser: false };
}

/**
 * A single recipient always fits, because `limits.messageLength` plus one mention stays under
 * Discord's 2,000. Raising that limit past ~1,970 would make this loop unable to place an ID.
 */
export function batches(plan: PingPlan): PingBatch[] {
  const result: PingBatch[] = [];
  let users: string[] = [];
  const content = (ids: string[]) => `${plan.message}\n\n${ids.map(id => `<@${id}>`).join(' ')}`;
  const flush = () => {
    if (users.length) {
      result.push({
        content: content(users),
        allowedMentions: { parse: [], users, repliedUser: false },
      });
    }
    users = [];
  };
  for (const id of plan.recipients) {
    const full =
      users.length === DISCORD_MENTIONS_PER_MESSAGE ||
      content([...users, id]).length > DISCORD_MESSAGE_LENGTH;
    if (full) flush();
    users.push(id);
  }
  flush();
  return result;
}

export interface DeliveryResult {
  sentRecipients: number;
  sentMessages: number;
  complete: boolean;
}

/** On failure, never retry already delivered batches or silently claim success. */
export async function deliver(
  plan: PingPlan,
  send: (batch: PingBatch) => Promise<unknown>,
): Promise<DeliveryResult> {
  let sentRecipients = 0;
  let sentMessages = 0;
  for (const batch of batches(plan)) {
    try {
      await send(batch);
    } catch {
      return { sentRecipients, sentMessages, complete: false };
    }
    sentRecipients += batch.allowedMentions.users.length;
    sentMessages++;
  }
  return { sentRecipients, sentMessages, complete: true };
}
