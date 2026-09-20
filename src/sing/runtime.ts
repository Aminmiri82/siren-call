import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import { parse } from './parser.js';
import type { Expr, Statement } from './parser.js';
import type { Value, RecordValue, ExecutionOptions, ExecutionResult } from './types.js';

const integerCost = (value: Value): number =>
  typeof value === 'bigint' ? value.toString().replace('-', '').length : 0;

class Scope {
  readonly values = new Map<string, Value>();
  constructor(readonly parent?: Scope) {}
  owner(name: string): Scope | undefined {
    return this.values.has(name) ? this : this.parent?.owner(name);
  }
}

export function execute(source: string, options: ExecutionOptions): ExecutionResult {
  const { limits, host } = options;
  for (const name of [
    'sourceBytes',
    'singSteps',
    'singDepth',
    'singStringLength',
    'singIntegerDigits',
  ] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0)
      throw new Error(`Invalid Sing limit: ${name}. Expected a positive safe integer.`);
  }
  if (new TextEncoder().encode(source).length > limits.sourceBytes)
    fail(source, { start: 0, end: 0 }, 'source-limit', 'Sing script is too large.');
  const statements = parse(source, host?.names ?? { has: () => false }, limits.singDepth);
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
    if (typeof value === 'bigint') {
      const digits = integerCost(value);
      tick(span, digits);
      if (digits > limits.singIntegerDigits)
        fail(source, span, 'integer-limit', 'Sing integer is too large.');
    }
    if (typeof value === 'number' && !Number.isFinite(value))
      fail(source, span, 'number', 'Arithmetic produced a non-finite number.');
    return value;
  };
  const unavailable = (span: Span): never =>
    fail(source, span, 'host', 'This operation requires the Discord selection host.');
  const services = {
    tick,
    text,
    fail: (span: Span, code: string, message: string): never => fail(source, span, code, message),
  };
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
    if (expr.kind === 'audience')
      return host?.audience(expr.name, expr, services) ?? unavailable(expr);
    if (expr.kind === 'literal') return bounded(expr.value, expr);
    if (expr.kind === 'name')
      return host?.resolve(expr.name, expr.reference, expr, services) ?? unavailable(expr);
    if (expr.kind === 'variable') {
      const owner = scope.owner(expr.name);
      if (owner) return owner.values.get(expr.name)!;
      if (expr.name === 'NONE') return new Set<string>();
      const value = host?.variable(expr.name);
      if (value !== undefined) return value;
      return fail(
        source,
        expr,
        'unknown-variable',
        `Unknown variable “${expr.name}”. Declare it with LET; recipient names start with @.`,
      );
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
      tick(expr, integerCost(value));
      if (expr.op === '-')
        return typeof value === 'number' || typeof value === 'bigint'
          ? bounded(-value, expr)
          : problem(expr, 'Unary - needs a number.');
      if (typeof value === 'boolean') return !value;
      return combine(
        host?.audience('everyone', expr, services) ?? unavailable(expr),
        set(value, expr.value),
        '-',
        expr,
      );
    }
    if (expr.kind === 'binary') {
      const left = ev(expr.left);
      // Boolean operators short-circuit; recipient sets always evaluate both sides.
      if (expr.op === 'AND' && left === false) return false;
      if (expr.op === 'OR' && left === true) return true;
      const right = ev(expr.right);
      if (['==', '!=', '<', '>', '<=', '>='].includes(expr.op))
        tick(
          expr,
          integerCost(left) +
            integerCost(right) +
            (typeof left === 'string' ? left.length : 0) +
            (typeof right === 'string' ? right.length : 0),
        );
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
          (typeof left === 'bigint' && typeof right === 'bigint') ||
          (typeof left === 'string' && typeof right === 'string')
        ))
          return problem(expr, 'Compare two integers, two decimals, or two strings.');
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
      if (typeof left === 'bigint' || typeof right === 'bigint') {
        tick(expr, integerCost(left) + integerCost(right));
        if (typeof left === 'bigint' && typeof right === 'bigint' && ['+', '-'].includes(expr.op))
          return bounded(expr.op === '+' ? left + right : left - right, expr);
      }
      if (typeof left === 'number' && typeof right === 'number' && ['+', '-'].includes(expr.op))
        return bounded(expr.op === '+' ? left + right : left - right, expr);
      if (
        (typeof left === 'bigint' && typeof right === 'number') ||
        (typeof left === 'number' && typeof right === 'bigint')
      )
        return problem(expr, 'Cannot mix exact integers and decimals. Use matching numeric types.');
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
      case 'COUNT': {
        arity(1);
        const value = args[0];
        if (value instanceof Set) return bounded(BigInt(value.size), expr);
        if (Array.isArray(value)) return bounded(BigInt(value.length), expr);
        return problem(expr, 'COUNT expects a recipient set, MEMBERS, or MESSAGES.');
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
        tick(expr, integerCost(value) + (typeof value === 'string' ? value.length : 0));
        return bounded(String(value), expr);
      }
      default: {
        const value = host?.call(expr.name, args, expr, services);
        if (value !== undefined) return bounded(value, expr);
        return fail(source, expr, 'function', `Unknown function “${expr.name}”.`);
      }
    }
  }
  function run(body: Statement[], scope: Scope): ExecutionResult | undefined {
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
      } else if (statement.kind === 'return') {
        const value = evaluate(statement.value, scope);
        if (value !== null && typeof value === 'object')
          return problem(statement, 'RETURN expects a scalar value.');
        return { kind: 'return', value };
      } else if (statement.kind === 'ping') {
        const recipients = [...set(evaluate(statement.recipients, scope), statement.recipients)];
        const message = text(evaluate(statement.message, scope), statement.message);
        if (!host) return unavailable(statement);
        const plan = host.ping({ recipients, message }, statement, services);
        return { kind: 'ping', value: plan };
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
          records = host?.records(value, statement, services) ?? unavailable(statement);
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
      'missing-result',
      'The script finished without a result. End with RETURN value or PING selection SAYING "message".',
    );
  return plan;
}
