import { limits, validatePlan } from '../../selection.js';
import type { CompileContext, PingPlan } from '../../selection.js';
import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import { Names } from './names.js';
import { parse } from './parser.js';
import type { Expr, Statement } from './parser.js';

type Scalar = string | number | boolean | null;
type RecordValue = { [key: string]: Scalar | string[] };
type Value = Scalar | Set<string> | RecordValue | RecordValue[];

class Scope {
  readonly values = new Map<string, Value>();
  constructor(readonly parent?: Scope) {}
  owner(name: string): Scope | undefined {
    return this.values.has(name) ? this : this.parent?.owner(name);
  }
}

export function execute(source: string, context: CompileContext): PingPlan {
  const names = new Names(context);
  const statements = parse(source, names);
  let steps = 0;
  const tick = (span: Span, cost = 1) => {
    steps += cost;
    if (steps > limits.singSteps)
      fail(
        source,
        span,
        'step-limit',
        'Sing exceeded its execution step limit. Try a smaller selection or a simpler loop.',
      );
  };
  const problem = (span: Span, message: string): never => fail(source, span, 'type', message);
  const text = (value: Value, span: Span): string =>
    typeof value === 'string' ? value : problem(span, 'Expected a string.');
  const boolean = (value: Value, span: Span): boolean =>
    typeof value === 'boolean'
      ? value
      : problem(span, 'Expected TRUE or FALSE. Use COUNT(selection) > 0 to test a selection.');
  const set = (value: Value, span: Span): Set<string> =>
    value instanceof Set
      ? value
      : problem(span, 'Expected a recipient set. Use @name, MEMBER(...), or ROLE(...).');
  const bounded = (value: Value, span: Span): Value => {
    if (typeof value === 'string' && value.length > limits.singStringLength)
      fail(source, span, 'string-limit', 'Sing string is too large.');
    if (typeof value === 'number' && !Number.isFinite(value))
      fail(source, span, 'number', 'Arithmetic produced a non-finite number.');
    return value;
  };
  const members = new Map(context.members.map(member => [member.id, member]));
  const all = new Set(members.keys());
  const combine = (left: Set<string>, right: Set<string>, op: string, span: Span) => {
    tick(span, left.size + right.size);
    const result = new Set<string>();
    for (const id of left) {
      if (op === '+' || op === 'OR' || (op === 'AND' ? right.has(id) : !right.has(id)))
        result.add(id);
    }
    if (op === '+' || op === 'OR' || op === 'XOR') {
      for (const id of right) if (op !== 'XOR' || !left.has(id)) result.add(id);
    }
    return result;
  };
  function evaluate(expr: Expr, scope: Scope, depth = 0): Value {
    tick(expr);
    if (depth > limits.singDepth)
      fail(
        source,
        expr,
        'depth-limit',
        'Sing expression is too deep. Split it into LET statements.',
      );
    const ev = (child: Expr) => evaluate(child, scope, depth + 1);
    if (expr.kind === 'audience') {
      if (expr.name === 'everyone') return all;
      if (!context.presenceAvailable)
        fail(
          source,
          expr,
          'presence-unavailable',
          '@here requires available presence data. Enable the Presence intent and restart the bot; local fixtures must supply presenceAvailable and member presence statuses.',
        );
      tick(expr, context.members.length);
      return new Set(
        context.members
          .filter(member => member.presence === 'online' || member.presence === 'dnd')
          .map(member => member.id),
      );
    }
    if (expr.kind === 'literal') return bounded(expr.value, expr);
    if (expr.kind === 'name') {
      tick(expr, context.members.length + context.roles.length);
      return names.resolve(expr.name, expr.reference, source, expr);
    }
    if (expr.kind === 'variable') {
      const owner = scope.owner(expr.name);
      if (owner) return owner.values.get(expr.name)!;
      switch (expr.name) {
        case 'NONE':
          return new Set<string>();
        case 'CALLER':
          return members.has(context.callerId) ? new Set([context.callerId]) : new Set<string>();
        case 'MEMBERS':
          return context.members as unknown as RecordValue[];
        case 'MESSAGES':
          return context.messages as unknown as RecordValue[];
        default:
          return fail(
            source,
            expr,
            'unknown-variable',
            `Unknown variable “${expr.name}”. Declare it with LET; recipient names start with @.`,
          );
      }
    }
    if (expr.kind === 'field') {
      const value = ev(expr.value);
      if (!value || typeof value !== 'object' || value instanceof Set || Array.isArray(value))
        return problem(expr, 'Only member and message records have fields.');
      if (!Object.hasOwn(value, expr.field))
        return fail(
          source,
          expr,
          'field',
          `Unknown field “${expr.field}”. Available fields: ${Object.keys(value).join(', ')}.`,
        );
      const field = value[expr.field];
      if (Array.isArray(field))
        return problem(
          expr,
          'roleIds is not a recipient set. Use ROLE(...) to select role members.',
        );
      return field ?? null;
    }
    if (expr.kind === 'unary') {
      const value = ev(expr.value);
      if (expr.op === '-')
        return typeof value === 'number'
          ? bounded(-value, expr)
          : problem(expr, 'Unary - needs a number.');
      if (typeof value === 'boolean') return !value;
      return combine(all, set(value, expr.value), '-', expr);
    }
    if (expr.kind === 'binary') {
      const left = ev(expr.left);
      // Boolean operators short-circuit; recipient sets always evaluate both sides.
      if (expr.op === 'AND' && left === false) return false;
      if (expr.op === 'OR' && left === true) return true;
      const right = ev(expr.right);
      if (['==', '!='].includes(expr.op)) {
        if (
          (left !== null && typeof left === 'object') ||
          (right !== null && typeof right === 'object')
        )
          return problem(
            expr,
            'Equality compares strings, numbers, booleans, or NULL. Use set operators for selections.',
          );
        return expr.op === '==' ? left === right : left !== right;
      }
      if (['<', '>', '<=', '>='].includes(expr.op)) {
        if (!(
          (typeof left === 'number' && typeof right === 'number') ||
          (typeof left === 'string' && typeof right === 'string')
        ))
          return problem(expr, 'Compare two numbers or two strings.');
        switch (expr.op) {
          case '<':
            return left < right;
          case '>':
            return left > right;
          case '<=':
            return left <= right;
          default:
            return left >= right;
        }
      }
      if (typeof left === 'number' && typeof right === 'number' && ['+', '-'].includes(expr.op))
        return bounded(expr.op === '+' ? left + right : left - right, expr);
      if (typeof left === 'string' && typeof right === 'string' && expr.op === '+') {
        tick(expr, left.length + right.length);
        return bounded(left + right, expr);
      }
      if (typeof left === 'boolean' && typeof right === 'boolean') {
        if (expr.op === 'AND') return left && right;
        if (expr.op === 'OR') return left || right;
        if (expr.op === 'XOR') return left !== right;
      }
      return combine(set(left, expr.left), set(right, expr.right), expr.op, expr);
    }
    const args = expr.args.map(ev);
    const arity = (count: number) => {
      if (args.length !== count)
        fail(
          source,
          expr,
          'arguments',
          `${expr.name} expects ${count} argument${count === 1 ? '' : 's'}.`,
        );
    };
    switch (expr.name) {
      case 'MEMBER':
      case 'ROLE': {
        arity(1);
        tick(expr, context.members.length + context.roles.length);
        return names.resolve(
          text(args[0]!, expr),
          expr.name === 'MEMBER' ? 'member' : 'role',
          source,
          expr,
        );
      }
      case 'COUNT': {
        arity(1);
        const value = args[0];
        if (value instanceof Set) return value.size;
        if (Array.isArray(value)) return value.length;
        return problem(expr, 'COUNT expects a recipient set, MEMBERS, or MESSAGES.');
      }
      case 'JOINED_AFTER': {
        arity(1);
        const date = text(args[0]!, expr);
        const timestamp = Date.parse(date + 'T00:00:00.000Z');
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(timestamp) ||
          new Date(timestamp).toISOString().slice(0, 10) !== date
        )
          fail(source, expr, 'date', 'Use a valid UTC date: YYYY-MM-DD.');
        tick(expr, members.size);
        return new Set(
          context.members
            .filter(member => member.joinedAt && member.joinedAt > date + 'T00:00:00.000Z')
            .map(member => member.id),
        );
      }
      case 'CONTAINS': {
        arity(2);
        const haystack = text(args[0]!, expr);
        const needle = text(args[1]!, expr);
        tick(expr, haystack.length + needle.length);
        return haystack.includes(needle);
      }
      case 'TEXT': {
        arity(1);
        const value = args[0]!;
        if (value !== null && typeof value === 'object')
          return problem(expr, 'TEXT expects a string, number, boolean, or NULL.');
        return String(value);
      }
      default:
        return fail(
          source,
          expr,
          'function',
          `Unknown function “${expr.name}”. Available functions: MEMBER, ROLE, COUNT, JOINED_AFTER, CONTAINS, TEXT.`,
        );
    }
  }
  function run(body: Statement[], scope: Scope): PingPlan | undefined {
    for (const statement of body) {
      tick(statement);
      if (statement.kind === 'let' || statement.kind === 'assign') {
        const owner = statement.kind === 'let' ? scope : scope.owner(statement.name);
        if (!owner)
          fail(
            source,
            statement,
            'unknown-variable',
            `Unknown variable “${statement.name}”. Declare it with LET first.`,
          );
        if (statement.kind === 'let' && scope.values.has(statement.name))
          fail(
            source,
            statement,
            'duplicate-variable',
            `“${statement.name}” is already declared in this scope.`,
          );
        owner.values.set(statement.name, evaluate(statement.value, scope));
      } else if (statement.kind === 'ping') {
        const recipients = [...set(evaluate(statement.recipients, scope), statement.recipients)];
        const message = text(evaluate(statement.message, scope), statement.message);
        try {
          return validatePlan({ recipients, message }, context);
        } catch (error) {
          fail(source, statement, 'invalid-plan', (error as Error).message);
        }
      } else if (statement.kind === 'if') {
        const plan = run(
          boolean(evaluate(statement.condition, scope), statement.condition)
            ? statement.yes
            : statement.no,
          new Scope(scope),
        );
        if (plan) return plan;
      } else if (statement.kind === 'while') {
        while (boolean(evaluate(statement.condition, scope), statement.condition)) {
          tick(statement);
          const plan = run(statement.body, new Scope(scope));
          if (plan) return plan;
        }
      } else if (statement.kind === 'for') {
        const value = evaluate(statement.collection, scope);
        let records: RecordValue[];
        if (value instanceof Set)
          records = [...value].map(id => members.get(id)! as unknown as RecordValue);
        else if (Array.isArray(value)) records = value;
        else
          return problem(
            statement.collection,
            'FOR expects a recipient set, MEMBERS, or MESSAGES.',
          );
        for (const record of records) {
          tick(statement);
          const child = new Scope(scope);
          child.values.set(statement.name, record);
          const plan = run(statement.body, child);
          if (plan) return plan;
        }
      }
    }
    return undefined;
  }
  const plan = run(statements, new Scope());
  if (!plan)
    fail(
      source,
      { start: source.length, end: source.length },
      'missing-ping',
      'The script finished without PING. End with PING selection SAYING "message".',
    );
  return plan;
}
