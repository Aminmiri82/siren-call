import { limits, validatePlan } from '../../selection.js';
import type { CompileContext, PingPlan } from '../../selection.js';
import { execute as executeCore } from '../../sing/index.js';
import type { RecordValue, SelectionHost } from '../../sing/types.js';
import { SingError, fail as failAt } from './diagnostics.js';
import { Names } from './names.js';

export function execute(source: string, context: CompileContext): PingPlan {
  const names = new Names(context);
  const members = new Map(context.members.map(member => [member.id, member]));
  const all = new Set(members.keys());
  const host: SelectionHost = {
    names,
    audience(name, span, { tick, fail }) {
      if (name === 'everyone') return all;
      if (!context.presenceAvailable)
        fail(
          span,
          'presence-unavailable',
          '@here requires available presence data. Enable the Presence intent and restart the bot; local fixtures must supply presenceAvailable and member presence statuses.',
        );
      tick(span, context.members.length);
      return new Set(
        context.members
          .filter(member => member.presence === 'online' || member.presence === 'dnd')
          .map(member => member.id),
      );
    },
    resolve(name, kind, span, { tick }) {
      tick(span, context.members.length + context.roles.length);
      return names.resolve(name, kind, source, span);
    },
    variable(name) {
      switch (name) {
        case 'CALLER':
          return members.has(context.callerId) ? new Set([context.callerId]) : new Set<string>();
        case 'MEMBERS':
          return context.members as unknown as RecordValue[];
        case 'MESSAGES':
          return context.messages as unknown as RecordValue[];
        default:
          return undefined;
      }
    },
    call(name, args, span, services) {
      const { tick, text, fail } = services;
      if (!['MEMBER', 'ROLE', 'JOINED_AFTER'].includes(name)) return undefined;
      if (args.length !== 1) fail(span, 'arguments', `${name} expects 1 argument.`);
      const reference = text(args[0]!, span);
      if (name !== 'JOINED_AFTER')
        return host.resolve(reference, name === 'MEMBER' ? 'member' : 'role', span, services);
      const timestamp = Date.parse(reference + 'T00:00:00.000Z');
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(reference) ||
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== reference
      )
        fail(span, 'date', 'Use a valid UTC date: YYYY-MM-DD.');
      tick(span, members.size);
      return new Set(
        context.members
          .filter(member => member.joinedAt && member.joinedAt > reference + 'T00:00:00.000Z')
          .map(member => member.id),
      );
    },
    records(ids, span, { tick }) {
      tick(span, ids.size);
      return [...ids].map(id => members.get(id)! as unknown as RecordValue);
    },
    ping(plan, span) {
      try {
        return validatePlan(plan, context);
      } catch (error) {
        return failAt(source, span, 'invalid-plan', (error as Error).message);
      }
    },
  };
  let result;
  try {
    result = executeCore(source, { limits, host });
  } catch (error) {
    if (error instanceof SingError && error.diagnostic.code === 'missing-result')
      failAt(
        source,
        error.diagnostic,
        'missing-ping',
        'The script finished without PING. End with PING selection SAYING "message".',
      );
    throw error;
  }
  if (result.kind !== 'ping')
    failAt(
      source,
      { start: 0, end: source.length },
      'missing-ping',
      'Discord selection scripts must produce PING, not RETURN.',
    );
  return result.value;
}
