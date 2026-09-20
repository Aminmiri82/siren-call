import type { CompileContext } from './selection.js';

const normalize = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Distinguishable from "no match" so an adapter can fall through on one but not the other. */
export class AmbiguousMemberError extends Error {}

/** Shared by language adapters; never guess between matching people. */
export function resolveMember(reference: string, context: CompileContext): string {
  const id =
    reference.match(/^<@!?(\d+)>$/)?.[1] ?? (/^\d+$/.test(reference) ? reference : undefined);
  if (id) {
    if (context.members.some(member => member.id === id)) return id;
    throw new Error(`No member matches “${reference}” in this channel.`);
  }
  const name = normalize(reference.replace(/^@/, ''));
  const matches = context.members.filter(member =>
    [member.name, member.username, member.globalName].some(
      alias => alias && normalize(alias) === name,
    ),
  );
  if (!matches.length) {
    throw new Error(
      `No member matches “${reference}” in this channel. Try their server name, @username, or a Discord mention.`,
    );
  }
  if (matches.length > 1) {
    throw new AmbiguousMemberError(
      `Ambiguous member name: “${reference}”. Use a Discord mention or user ID to choose one person.`,
    );
  }
  return matches[0]!.id;
}
