import { resolveMember } from '../../members.js';
import type { CompileContext } from '../../selection.js';
import { SingError, fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';

const normalize = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function distance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let row = right.map((_, i) => i + 1);
  row.unshift(0);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) {
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (left[i] === right[j] ? 0 : 1)));
    }
    row = next;
  }
  return row[right.length]!;
}

export class Names {
  private readonly aliases = new Map<string, string>();
  constructor(private readonly context: CompileContext) {
    for (const role of context.roles) this.aliases.set(normalize(role.name), role.name);
    for (const member of context.members) {
      for (const alias of [member.name, member.username, member.globalName]) {
        if (alias) this.aliases.set(normalize(alias), alias);
      }
    }
  }

  has(name: string): boolean {
    return this.aliases.has(normalize(name));
  }

  resolve(
    name: string,
    kind: 'member' | 'role' | 'either',
    source: string,
    span: Span,
  ): Set<string> {
    const roleById =
      kind === 'role' ? this.context.roles.find(role => role.id === name) : undefined;
    const roles = roleById
      ? [roleById]
      : this.context.roles.filter(role => normalize(role.name) === normalize(name));
    let id: string | undefined;
    let memberError: Error | undefined;
    if (kind !== 'role') {
      try {
        id = resolveMember(name, this.context, kind === 'either' ? 'name' : 'reference');
      } catch (error) {
        memberError = error as Error;
      }
    }
    if (kind === 'member' && id) return new Set([id]);
    if (
      kind === 'either' &&
      roles.length &&
      (id || memberError?.message.startsWith('Ambiguous member name'))
    ) {
      fail(
        source,
        span,
        'ambiguous-name',
        `“${name}” matches a role and a member. Use ROLE(${JSON.stringify(name)}) or MEMBER(${JSON.stringify(name)}); use IDs if needed.`,
      );
    }
    if (memberError && memberError.message.startsWith('Ambiguous member name')) {
      fail(source, span, 'ambiguous-member', memberError.message);
    }
    if (kind !== 'member' && roles.length) {
      if (roles.length > 1)
        fail(
          source,
          span,
          'ambiguous-role',
          `Ambiguous role name: “${name}”. Use ROLE("role ID").`,
        );
      return new Set(
        this.context.members
          .filter(member => member.roleIds.includes(roles[0]!.id))
          .map(member => member.id),
      );
    }
    if (id) return new Set([id]);
    const key = normalize(name).slice(0, 100);
    const suggestions = [...this.aliases.entries()]
      .filter(([alias]) => Math.abs(alias.length - key.length) <= 3 && alias.length <= 100)
      .map(([alias, spelling]) => ({ spelling, score: distance(key, alias) }))
      .filter(item => item.score <= Math.min(3, Math.max(1, Math.floor(key.length / 3))))
      .toSorted((a, b) => a.score - b.score || a.spelling.localeCompare(b.spelling))
      .slice(0, 3)
      .map(item => `@${JSON.stringify(item.spelling)}`);
    throw new SingError(
      {
        ...span,
        code: 'unknown-recipient',
        message: `Unknown ${kind === 'either' ? 'recipient' : kind} “${name}” in this channel.`,
        suggestions,
      },
      source,
    );
  }
}
