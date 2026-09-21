import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import { primitive, primitiveNames } from './primitives.js';
import { parse } from './parser.js';
import type { Expr, Statement, TypeExpr } from './parser.js';
import type { Value as HostValue, ExecutionOptions, ExecutionResult, Plan } from './types.js';
import { Scope, tagged } from './values.js';
import type { Value, FunctionValue } from './values.js';

const integerCost = (value: Value): number =>
  typeof value === 'bigint' ? value.toString().replace('-', '').length : 0;

type Completion = { kind: 'return'; value: Value } | { kind: 'ping'; value: Plan };
// PING can arise inside any expression through a function call, and ends the entire script.
class PingSignal {
  constructor(readonly completion: Extract<Completion, { kind: 'ping' }>) {}
}
const builtins = new Set([
  ...primitiveNames,
  'COUNT',
  'CONTAINS',
  'TEXT',
  'APPEND',
  'LENGTH',
  'SLICE',
  'MEMBER',
  'ROLE',
  'JOINED_AFTER',
]);
const primitiveTypes = new Set(['Int', 'Decimal', 'String', 'Bool', 'Null']);

const valueDepth = (value: Value) =>
  tagged(value, 'list') || tagged(value, 'record') ? value.depth : 0;

export function execute(source: string, options: ExecutionOptions): ExecutionResult {
  const { limits, host } = options;
  for (const name of [
    'sourceBytes',
    'singSteps',
    'singDepth',
    'singStringLength',
    'singIntegerDigits',
    'singCollectionItems',
  ] as const) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0)
      throw new Error(`Invalid Sing limit: ${name}. Expected a positive safe integer.`);
  }
  if (new TextEncoder().encode(source).length > limits.sourceBytes)
    fail(source, { start: 0, end: 0 }, 'source-limit', 'Sing script is too large.');
  const statements = parse(source, host?.names ?? { has: () => false }, limits.singDepth);
  let steps = 0;
  let executionDepth = 0;
  const hostOrigins = new WeakMap<object, HostValue>();
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
    text: (value: HostValue, span: Span) =>
      typeof value === 'string' ? value : problem(span, 'Expected a string.'),
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
  function collectionDepth(values: readonly Value[], span: Span): number {
    tick(span, values.length);
    if (values.length > limits.singCollectionItems)
      fail(source, span, 'collection-limit', 'Sing collection is too large.');
    let depth = 1;
    for (const value of values) depth = Math.max(depth, valueDepth(value) + 1);
    if (depth > limits.singDepth)
      fail(source, span, 'depth-limit', 'Sing collection nesting is too deep.');
    return depth;
  }
  function list(items: Value[], span: Span): Extract<Value, { kind: 'list' }> {
    const depth = collectionDepth(items, span);
    return { kind: 'list', items: Object.freeze(items), depth };
  }
  function fromHost(value: HostValue, span: Span): Value {
    if (Array.isArray(value)) {
      const result = list(
        value.map(item => fromHost(item, span)),
        span,
      );
      hostOrigins.set(result, value);
      return result;
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Set)) {
      const fields = new Map<string, Value>();
      const hidden = new Set<string>();
      for (const [name, member] of Object.entries(value)) {
        tick(span);
        if (Array.isArray(member)) hidden.add(name);
        else fields.set(name, bounded(member ?? null, span));
      }
      const result: Extract<Value, { kind: 'record' }> = {
        kind: 'record',
        fields,
        hidden,
        depth: collectionDepth([...fields.values()], span),
      };
      hostOrigins.set(result, value);
      return result;
    }
    return bounded(value, span);
  }
  function field(value: Value, name: string, span: Span): Value {
    if (!tagged(value, 'record')) return problem(span, 'Only records have fields.');
    if (value.hidden?.has(name))
      return problem(span, 'roleIds is not a recipient set. Use ROLE(...) to select role members.');
    if (!value.fields.has(name)) return fail(source, span, 'field', `Unknown field “${name}”.`);
    return value.fields.get(name)!;
  }
  function resolveType(type: TypeExpr, scope: Scope, depth = 0): TypeExpr {
    tick(type);
    if (depth > limits.singDepth)
      return fail(source, type, 'depth-limit', 'Sing type nesting is too deep.');
    if (type.kind === 'named') {
      if (primitiveTypes.has(type.name)) return type;
      const alias = scope.type(type.name);
      if (!alias)
        return fail(
          source,
          type,
          'unknown-type',
          `Unknown type “${type.name}”. Declare aliases before use; recursive aliases are not supported.`,
        );
      // Revisit expanded aliases so many shallow declarations cannot evade the depth bound.
      return resolveType(alias, scope, depth + 1);
    }
    if (type.kind === 'list')
      return { ...type, element: resolveType(type.element, scope, depth + 1) };
    return {
      ...type,
      fields: type.fields.map(item => ({
        ...item,
        type: resolveType(item.type, scope, depth + 1),
      })),
    };
  }
  function checkType(value: Value, type: TypeExpr, span: Span, path: string, depth = 0): void {
    tick(span);
    if (depth > limits.singDepth) fail(source, span, 'depth-limit', 'Sing type check is too deep.');
    if (type.kind === 'list') {
      if (!tagged(value, 'list')) return problem(span, `${path} expects List.`);
      for (let i = 0; i < value.items.length; i++)
        checkType(value.items[i]!, type.element, span, `${path}[${i}]`, depth + 1);
      return;
    }
    if (type.kind === 'record') {
      if (!tagged(value, 'record')) return problem(span, `${path} expects a record.`);
      for (const item of type.fields) {
        if (!value.fields.has(item.name))
          return problem(span, `${path} is missing field “${item.name}”.`);
        checkType(value.fields.get(item.name)!, item.type, span, `${path}.${item.name}`, depth + 1);
      }
      return;
    }
    const matches =
      type.name === 'Int'
        ? typeof value === 'bigint'
        : type.name === 'Decimal'
          ? typeof value === 'number'
          : type.name === 'String'
            ? typeof value === 'string'
            : type.name === 'Bool'
              ? typeof value === 'boolean'
              : value === null;
    if (!matches) problem(span, `${path} expects ${type.name}.`);
  }
  function callFunction(fn: FunctionValue, args: Value[], span: Span): Value {
    if (args.length !== fn.parameters.length)
      fail(source, span, 'arguments', `${fn.name} expects ${fn.parameters.length} arguments.`);
    const scope = new Scope(fn.environment);
    fn.parameters.forEach((parameter, i) => {
      const value = args[i]!;
      if (parameter.resolved) checkType(value, parameter.resolved, span, parameter.name);
      scope.values.set(parameter.name, { value, annotation: parameter.resolved });
    });
    const result = run(fn.body, scope);
    if (result?.kind === 'ping') throw new PingSignal(result);
    const value = result?.value ?? null;
    if (fn.resultType) checkType(value, fn.resultType, span, `${fn.name} return`);
    return value;
  }
  function nested<T>(span: Span, action: () => T): T {
    if (++executionDepth > limits.singDepth)
      fail(source, span, 'depth-limit', 'Sing execution nesting is too deep.');
    try {
      return action();
    } finally {
      executionDepth--;
    }
  }
  function evaluate(expr: Expr, scope: Scope): Value {
    return nested(expr, () => evaluateInner(expr, scope));
  }
  function evaluateInner(expr: Expr, scope: Scope): Value {
    tick(expr);
    const ev = (child: Expr) => evaluate(child, scope);
    if (expr.kind === 'audience')
      return host?.audience(expr.name, expr, services) ?? unavailable(expr);
    if (expr.kind === 'literal') return bounded(expr.value, expr);
    if (expr.kind === 'name')
      return host?.resolve(expr.name, expr.reference, expr, services) ?? unavailable(expr);
    if (expr.kind === 'variable') {
      const owner = scope.owner(expr.name);
      if (owner) return owner.values.get(expr.name)!.value;
      if (builtins.has(expr.name)) return { kind: 'builtin', name: expr.name };
      if (expr.name === 'NONE') return new Set<string>();
      const value = host?.variable(expr.name);
      if (value !== undefined) return fromHost(value, expr);
      return fail(
        source,
        expr,
        'unknown-variable',
        `Unknown variable “${expr.name}”. Declare it with LET; recipient names start with @.`,
      );
    }
    if (expr.kind === 'list') return list(expr.items.map(ev), expr);
    if (expr.kind === 'record') {
      const fields = new Map(expr.fields.map(item => [item.name, ev(item.value)]));
      return { kind: 'record', fields, depth: collectionDepth([...fields.values()], expr) };
    }
    if (expr.kind === 'field') return field(ev(expr.value), expr.field, expr);
    if (expr.kind === 'index') {
      const value = ev(expr.value);
      const index = ev(expr.index);
      if (tagged(value, 'record')) return field(value, text(index, expr.index), expr);
      if (!tagged(value, 'list') && typeof value !== 'string')
        return problem(expr, 'Indexing expects a list, string, or record.');
      const length = typeof value === 'string' ? value.length : value.items.length;
      if (typeof index !== 'bigint') return problem(expr.index, 'Index expects an Int.');
      if (index < 0n || index >= BigInt(length))
        return fail(source, expr.index, 'index', 'Index is out of bounds.');
      return typeof value === 'string' ? value[Number(index)]! : value.items[Number(index)]!;
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
    // Unbound named calls retain the trusted embedding host's built-in dispatch hook.
    const callee: Value =
      expr.callee.kind === 'variable' && !scope.owner(expr.callee.name)
        ? { kind: 'builtin', name: expr.callee.name }
        : ev(expr.callee);
    const args = expr.args.map(ev);
    if (tagged(callee, 'function')) return callFunction(callee, args, expr);
    if (!tagged(callee, 'builtin')) return problem(expr.callee, 'This value is not callable.');
    const name = callee.name;

    const arity = (count: number) => {
      if (args.length !== count)
        fail(
          source,
          expr,
          'arguments',
          `${name} expects ${count} argument${count === 1 ? '' : 's'}.`,
        );
    };
    if (primitiveNames.includes(name))
      return bounded(primitive(name, args, source, expr, limits, tick), expr);
    switch (name) {
      case 'COUNT': {
        arity(1);
        const value = args[0];
        if (value instanceof Set) return bounded(BigInt(value.size), expr);
        if (value !== undefined && tagged(value, 'list'))
          return bounded(BigInt(value.items.length), expr);
        return problem(expr, 'COUNT expects a list, recipient set, MEMBERS, or MESSAGES.');
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
      case 'APPEND': {
        arity(2);
        const value = args[0]!;
        if (!tagged(value, 'list')) return problem(expr, 'APPEND expects a list.');
        // Charge and bound before copying a potentially large list.
        tick(expr, value.items.length);
        if (value.items.length >= limits.singCollectionItems)
          fail(source, expr, 'collection-limit', 'Sing collection is too large.');
        return list([...value.items, args[1]!], expr);
      }
      case 'LENGTH': {
        arity(1);
        return bounded(BigInt(text(args[0]!, expr).length), expr);
      }
      case 'SLICE': {
        arity(3);
        const value = text(args[0]!, expr);
        const start = args[1]!;
        const end = args[2]!;
        if (typeof start !== 'bigint' || typeof end !== 'bigint')
          return problem(expr, 'SLICE bounds expect Int.');
        if (start < 0n || end < start || end > BigInt(value.length))
          fail(source, expr, 'index', 'SLICE bounds are out of range.');
        tick(expr, Number(end - start));
        return bounded(value.slice(Number(start), Number(end)), expr);
      }
      default: {
        const hostArgs = args.map(value => {
          if (value !== null && typeof value === 'object' && !(value instanceof Set)) {
            const original = hostOrigins.get(value);
            if (original !== undefined) return original;
            return problem(
              expr,
              'Host functions cannot receive user-created collections or functions.',
            );
          }
          return value;
        });
        const value = host?.call(name, hostArgs, expr, services);
        if (value !== undefined) return fromHost(value, expr);
        return fail(source, expr, 'function', `Unknown function “${name}”.`);
      }
    }
  }
  function run(body: Statement[], scope: Scope): Completion | undefined {
    return nested(body[0] ?? { start: 0, end: 0 }, () => runInner(body, scope));
  }
  function runInner(body: Statement[], scope: Scope): Completion | undefined {
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
        const annotation = statement.annotation
          ? resolveType(statement.annotation, scope)
          : owner.values.get(statement.name)?.annotation;
        const value = evaluate(statement.value, scope);
        if (annotation) checkType(value, annotation, statement.value, statement.name);
        owner.values.set(statement.name, { value, annotation });
      } else if (statement.kind === 'type') {
        if (
          primitiveTypes.has(statement.name) ||
          statement.name === 'List' ||
          scope.types.has(statement.name)
        )
          fail(
            source,
            statement,
            'duplicate-type',
            `Type “${statement.name}” is already declared or reserved.`,
          );
        scope.types.set(statement.name, resolveType(statement.value, scope));
      } else if (statement.kind === 'func') {
        if (scope.values.has(statement.name))
          fail(
            source,
            statement,
            'duplicate-variable',
            `“${statement.name}” is already declared in this scope.`,
          );
        const value: FunctionValue = {
          kind: 'function',
          name: statement.name,
          body: statement.body,
          environment: scope,
          parameters: statement.parameters.map(parameter => ({
            ...parameter,
            resolved: parameter.annotation ? resolveType(parameter.annotation, scope) : undefined,
          })),
          resultType: statement.annotation ? resolveType(statement.annotation, scope) : undefined,
        };
        scope.values.set(statement.name, { value });
      } else if (statement.kind === 'expression') {
        evaluate(statement.value, scope);
      } else if (statement.kind === 'return') {
        const value = evaluate(statement.value, scope);
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
        let records: readonly Value[];
        if (value instanceof Set)
          records = (host?.records(value, statement, services) ?? unavailable(statement)).map(
            record => fromHost(record, statement),
          );
        else if (tagged(value, 'list')) records = value.items;
        else
          return problem(
            statement.collection,
            'FOR expects a list, recipient set, MEMBERS, or MESSAGES.',
          );
        for (const record of records) {
          tick(statement);
          const child = new Scope(scope);
          child.values.set(statement.name, { value: record });
          const plan = run(statement.body, child);
          if (plan) return plan;
        }
      }
    }
    return undefined;
  }
  let plan: Completion | undefined;
  try {
    const root = new Scope();
    for (const [name, value] of Object.entries(options.globals ?? {})) {
      if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value))
        throw new Error('Sing globals must be scalar values.');
      root.values.set(name, { value: bounded(value, { start: 0, end: 0 }) });
    }
    plan = run(statements, root);
  } catch (error) {
    if (!(error instanceof PingSignal)) throw error;
    plan = error.completion;
  }
  if (!plan)
    fail(
      source,
      { start: source.length, end: source.length },
      'missing-result',
      'The script finished without a result. End with RETURN value or PING selection SAYING "message".',
    );
  if (plan.kind === 'ping') return plan;
  if (plan.value !== null && typeof plan.value === 'object')
    return problem({ start: 0, end: source.length }, 'Top-level RETURN expects a scalar value.');
  return { kind: 'return', value: plan.value };
}
