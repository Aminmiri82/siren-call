/** The only contract a language adapter needs to implement. No Discord objects. */
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
export interface CompileContext {
  members: Member[];
  roles: { id: string; name: string }[];
  callerId: string;
}
export interface PingPlan {
  recipients: string[];
  message: string;
}

export const limits = {
  sourceBytes: 16_000,
  messageLength: 1_500,
  recipients: 5_000,
  luaMemoryBytes: 16 * 1024 * 1024,
  executionMs: 2_000,
  startupMs: 10_000,
  previewMs: 5 * 60_000,
} as const;

/** Validate every adapter at the application boundary, not just Lua. */
export function validatePlan(value: unknown, context: CompileContext): PingPlan {
  if (!value || typeof value !== 'object') throw new Error('Return a ping with recipients and a message.');
  const plan = value as Partial<PingPlan>;
  if (typeof plan.message !== 'string' || !plan.message.trim() || plan.message.length > limits.messageLength) {
    throw new Error(`The message must contain 1–${limits.messageLength} characters.`);
  }
  if (!Array.isArray(plan.recipients) || plan.recipients.length > limits.recipients) {
    throw new Error(`Return an array of at most ${limits.recipients} recipient IDs.`);
  }
  const eligible = new Set(context.members.map(member => member.id));
  for (const id of plan.recipients) {
    if (typeof id !== 'string' || !eligible.has(id)) throw new Error(`Unknown or ineligible recipient: ${String(id).slice(0,50)}`);
  }
  return { recipients: [...new Set(plan.recipients)], message: plan.message };
}

export function permissionProblem(plan: PingPlan, context: CompileContext, canMentionEveryone: boolean): string | undefined {
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

export function batches(plan: PingPlan): PingBatch[] {
  const result: PingBatch[] = [];
  let users: string[] = [];
  const content = (ids: string[]) => `${plan.message}\n\n${ids.map(id => `<@${id}>`).join(' ')}`;
  const flush = () => {
    if (users.length) result.push({ content: content(users), allowedMentions: { parse: [], users, repliedUser: false } });
    users = [];
  };
  for (const id of plan.recipients) {
    if (users.length === 100 || content([...users, id]).length > 2000) flush();
    users.push(id);
  }
  flush();
  return result;
}

/** On failure, never retry already delivered batches or silently claim success. */
export async function deliver(plan: PingPlan, send: (batch: PingBatch) => Promise<unknown>) {
  let sentRecipients = 0;
  let sentMessages = 0;
  for (const batch of batches(plan)) {
    try { await send(batch); }
    catch { return { sentRecipients, sentMessages, complete: false }; }
    sentRecipients += batch.allowedMentions.users.length;
    sentMessages++;
  }
  return { sentRecipients, sentMessages, complete: true };
}
