import { limits as defaults } from '../selection.js';
import { fail } from '../sing/diagnostics.js';
import type { Span } from '../sing/diagnostics.js';
import type { TypeExpr } from '../sing/parser.js';
import type { ExecutionLimits, Scalar } from '../sing/types.js';
import { primitive, primitiveNames } from '../sing/primitives.js';
export { runMain } from './main.js';

type Position = readonly [number, number];
type Value = Scalar | List | RecordValue | Callable | Builtin;
type Binding = { value: Value; annotation?: TypeExpr };
type Parameter = { name: string; annotation?: TypeExpr };
export interface CompiledOptions {
  limits?: ExecutionLimits;
  globals?: Readonly<Record<string, Scalar>>;
}
class Scope {
  values = new Map<string, Binding>();
  types = new Map<string, TypeExpr>();
  constructor(readonly parent?: Scope) {}
  owner(name: string): Scope | undefined {
    if (this.values.has(name)) return this;
    for (let scope = this.parent; scope; scope = scope.parent)
      if (scope.values.has(name)) return scope;
    return undefined;
  }
  type(name: string): TypeExpr | undefined {
    const local = this.types.get(name);
    if (local) return local;
    for (let scope = this.parent; scope; scope = scope.parent) {
      const value = scope.types.get(name);
      if (value) return value;
    }
    return undefined;
  }
}
class List {
  constructor(
    readonly items: readonly Value[],
    readonly depth: number,
  ) {}
}
class RecordValue {
  constructor(
    readonly fields: ReadonlyMap<string, Value>,
    readonly depth: number,
  ) {}
}
class Callable {
  constructor(
    readonly name: string,
    readonly parameters: Parameter[],
    readonly annotation: TypeExpr | undefined,
    readonly environment: Scope,
    readonly body: (scope: Scope) => void,
  ) {}
}
class Builtin {
  constructor(readonly name: string) {}
}
class Returned {
  constructor(readonly value: Value) {}
}
const builtins = new Set([
  'COUNT',
  'CONTAINS',
  'TEXT',
  'APPEND',
  'LENGTH',
  'SLICE',
  ...primitiveNames,
]);
const primitiveTypes = new Set(['Int', 'Decimal', 'String', 'Bool', 'Null']);
const span = (p: Position): Span => ({ start: p[0], end: p[1] });
const integerCost = (value: Value) =>
  typeof value === 'bigint' ? value.toString().replace('-', '').length : 0;

/** Checked operations for generated JavaScript. This module does not parse or interpret ASTs. */
export class Runtime {
  readonly limits: ExecutionLimits;
  private steps = 0;
  private depth = 0;
  constructor(
    readonly source: string,
    readonly options: CompiledOptions = {},
  ) {
    this.limits = options.limits ?? defaults;
    for (const name of [
      'sourceBytes',
      'singSteps',
      'singDepth',
      'singStringLength',
      'singIntegerDigits',
      'singCollectionItems',
    ] as const)
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] <= 0)
        throw new Error(`Invalid Sing limit: ${name}. Expected a positive safe integer.`);
    if (new TextEncoder().encode(source).length > this.limits.sourceBytes)
      this.fail([0, 0], 'source-limit', 'Sing script is too large.');
  }
  fail(p: Position, code: string, message: string): never {
    return fail(this.source, span(p), code, message);
  }
  tick(p: Position, cost = 1): void {
    this.steps += cost;
    if (this.steps > this.limits.singSteps)
      this.fail(p, 'step-limit', 'Sing exceeded its execution step limit.');
  }
  private nested<T>(p: Position, action: () => T): T {
    if (++this.depth > this.limits.singDepth)
      this.fail(p, 'depth-limit', 'Sing execution nesting is too deep.');
    try {
      return action();
    } finally {
      this.depth--;
    }
  }
  e(p: Position, action: () => Value): Value {
    return this.nested(p, () => {
      this.tick(p);
      return action();
    });
  }
  private bounded(value: Value, p: Position): Value {
    if (typeof value === 'string' && value.length > this.limits.singStringLength)
      this.fail(p, 'string-limit', 'Sing string is too large.');
    if (typeof value === 'bigint') {
      const digits = integerCost(value);
      this.tick(p, digits);
      if (digits > this.limits.singIntegerDigits)
        this.fail(p, 'integer-limit', 'Sing integer is too large.');
    }
    if (typeof value === 'number' && !Number.isFinite(value))
      this.fail(p, 'number', 'Arithmetic produced a non-finite number.');
    return value;
  }
  literal(value: Scalar, p: Position): Value {
    return this.bounded(value, p);
  }
  number(text: string, decimal: boolean, p: Position): Value {
    return this.bounded(decimal ? Number(text) : BigInt(text), p);
  }
  get(scope: Scope, name: string, p: Position): Value {
    const owner = scope.owner(name);
    if (owner) return owner.values.get(name)!.value;
    if (builtins.has(name)) return new Builtin(name);
    return this.fail(p, 'unknown-variable', `Unknown variable “${name}”. Declare it with LET.`);
  }
  callee(scope: Scope, name: string, p: Position): Value {
    return scope.owner(name) ? this.e(p, () => this.get(scope, name, p)) : new Builtin(name);
  }
  private text(value: Value, p: Position): string {
    return typeof value === 'string' ? value : this.fail(p, 'type', 'Expected a string.');
  }
  boolean(value: Value, p: Position): boolean {
    return typeof value === 'boolean' ? value : this.fail(p, 'type', 'Expected TRUE or FALSE.');
  }
  unary(op: string, value: Value, p: Position): Value {
    this.tick(p, integerCost(value));
    if (op === '-' && (typeof value === 'bigint' || typeof value === 'number'))
      return this.bounded(-value, p);
    if (op === 'NOT' && typeof value === 'boolean') return !value;
    return this.fail(p, 'type', 'Invalid unary operand.');
  }
  binary(op: string, left: Value, rightThunk: () => Value, p: Position): Value {
    if (op === 'AND' && left === false) return false;
    if (op === 'OR' && left === true) return true;
    const right = rightThunk();
    if (['==', '!=', '<', '>', '<=', '>='].includes(op))
      this.tick(
        p,
        integerCost(left) +
          integerCost(right) +
          (typeof left === 'string' ? left.length : 0) +
          (typeof right === 'string' ? right.length : 0),
      );
    if (op === '==' || op === '!=') {
      if (
        (left !== null && typeof left === 'object') ||
        (right !== null && typeof right === 'object')
      )
        return this.fail(p, 'type', 'Equality compares scalar values only.');
      return op === '==' ? left === right : left !== right;
    }
    if (['<', '>', '<=', '>='].includes(op)) {
      if (!(
        (typeof left === 'number' && typeof right === 'number') ||
        (typeof left === 'bigint' && typeof right === 'bigint') ||
        (typeof left === 'string' && typeof right === 'string')
      ))
        return this.fail(p, 'type', 'Compare two integers, two decimals, or two strings.');
      if (op === '<') return left < right;
      if (op === '>') return left > right;
      if (op === '<=') return left <= right;
      return left >= right;
    }
    if (typeof left === 'bigint' || typeof right === 'bigint') {
      this.tick(p, integerCost(left) + integerCost(right));
      if (typeof left === 'bigint' && typeof right === 'bigint' && (op === '+' || op === '-'))
        return this.bounded(op === '+' ? left + right : left - right, p);
    }
    if (typeof left === 'number' && typeof right === 'number' && (op === '+' || op === '-'))
      return this.bounded(op === '+' ? left + right : left - right, p);
    if (typeof left === 'string' && typeof right === 'string' && op === '+') {
      this.tick(p, left.length + right.length);
      return this.bounded(left + right, p);
    }
    if (typeof left === 'boolean' && typeof right === 'boolean') {
      if (op === 'AND') return left && right;
      if (op === 'OR') return left || right;
      if (op === 'XOR') return left !== right;
    }
    return this.fail(p, 'type', 'Incompatible binary operands; numeric kinds cannot be mixed.');
  }
  private collectionDepth(values: readonly Value[], p: Position): number {
    this.tick(p, values.length);
    if (values.length > this.limits.singCollectionItems)
      this.fail(p, 'collection-limit', 'Sing collection is too large.');
    let depth = 1;
    for (const value of values)
      if (value instanceof List || value instanceof RecordValue)
        depth = Math.max(depth, value.depth + 1);
    if (depth > this.limits.singDepth)
      this.fail(p, 'depth-limit', 'Sing collection nesting is too deep.');
    return depth;
  }
  list(values: Value[], p: Position): Value {
    return new List(Object.freeze(values), this.collectionDepth(values, p));
  }
  record(fields: [string, Value][], p: Position): Value {
    return new RecordValue(
      new Map(fields),
      this.collectionDepth(
        fields.map(([, value]) => value),
        p,
      ),
    );
  }
  field(value: Value, name: string, p: Position): Value {
    if (!(value instanceof RecordValue)) return this.fail(p, 'type', 'Only records have fields.');
    if (!value.fields.has(name)) return this.fail(p, 'field', `Unknown field “${name}”.`);
    return value.fields.get(name)!;
  }
  index(value: Value, index: Value, p: Position, indexPosition: Position): Value {
    if (value instanceof RecordValue) return this.field(value, this.text(index, indexPosition), p);
    if (!(value instanceof List) && typeof value !== 'string')
      return this.fail(p, 'type', 'Indexing expects a list, string, or record.');
    if (typeof index !== 'bigint') return this.fail(indexPosition, 'type', 'Index expects an Int.');
    const length = typeof value === 'string' ? value.length : value.items.length;
    if (index < 0n || index >= BigInt(length))
      return this.fail(indexPosition, 'index', 'Index is out of bounds.');
    return typeof value === 'string' ? value[Number(index)]! : value.items[Number(index)]!;
  }
  private resolveType(type: TypeExpr, scope: Scope, depth = 0): TypeExpr {
    const p: Position = [type.start, type.end];
    this.tick(p);
    if (depth > this.limits.singDepth)
      return this.fail(p, 'depth-limit', 'Sing type nesting is too deep.');
    if (type.kind === 'named') {
      if (primitiveTypes.has(type.name)) return type;
      const alias = scope.type(type.name);
      if (!alias) return this.fail(p, 'unknown-type', `Unknown type “${type.name}”.`);
      return this.resolveType(alias, scope, depth + 1);
    }
    if (type.kind === 'list')
      return { ...type, element: this.resolveType(type.element, scope, depth + 1) };
    return {
      ...type,
      fields: type.fields.map(item => ({
        ...item,
        type: this.resolveType(item.type, scope, depth + 1),
      })),
    };
  }
  private check(value: Value, type: TypeExpr, p: Position, path: string, depth = 0): void {
    this.tick(p);
    if (depth > this.limits.singDepth) this.fail(p, 'depth-limit', 'Sing type check is too deep.');
    if (type.kind === 'list') {
      if (!(value instanceof List)) return this.fail(p, 'type', `${path} expects List.`);
      value.items.forEach((item, i) =>
        this.check(item, type.element, p, `${path}[${i}]`, depth + 1),
      );
    } else if (type.kind === 'record') {
      if (!(value instanceof RecordValue)) return this.fail(p, 'type', `${path} expects a record.`);
      for (const item of type.fields) {
        if (!value.fields.has(item.name))
          return this.fail(p, 'type', `${path} is missing field “${item.name}”.`);
        this.check(value.fields.get(item.name)!, item.type, p, `${path}.${item.name}`, depth + 1);
      }
    } else {
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
      if (!matches) this.fail(p, 'type', `${path} expects ${type.name}.`);
    }
  }
  type(scope: Scope, name: string, type: TypeExpr, p: Position): void {
    if (primitiveTypes.has(name) || name === 'List' || scope.types.has(name))
      this.fail(p, 'duplicate-type', `Type “${name}” is already declared or reserved.`);
    scope.types.set(name, this.resolveType(type, scope));
  }
  declare(
    scope: Scope,
    name: string,
    type: TypeExpr | undefined,
    value: () => Value,
    p: Position,
    valuePosition: Position,
  ): void {
    if (scope.values.has(name))
      this.fail(p, 'duplicate-variable', `“${name}” is already declared in this scope.`);
    const annotation = type ? this.resolveType(type, scope) : undefined;
    const result = value();
    if (annotation) this.check(result, annotation, valuePosition, name);
    scope.values.set(name, { value: result, annotation });
  }
  assign(
    scope: Scope,
    name: string,
    value: () => Value,
    p: Position,
    valuePosition: Position,
  ): void {
    const owner = scope.owner(name);
    if (!owner)
      return this.fail(
        p,
        'unknown-variable',
        `Unknown variable “${name}”. Declare it with LET first.`,
      );
    const binding = owner.values.get(name)!;
    const result = value();
    if (binding.annotation) this.check(result, binding.annotation, valuePosition, name);
    binding.value = result;
  }
  func(
    scope: Scope,
    name: string,
    parameters: Parameter[],
    type: TypeExpr | undefined,
    body: (scope: Scope) => void,
    p: Position,
  ): void {
    if (scope.values.has(name))
      this.fail(p, 'duplicate-variable', `“${name}” is already declared in this scope.`);
    const resolved = parameters.map(parameter => ({
      ...parameter,
      annotation: parameter.annotation ? this.resolveType(parameter.annotation, scope) : undefined,
    }));
    scope.values.set(name, {
      value: new Callable(
        name,
        resolved,
        type ? this.resolveType(type, scope) : undefined,
        scope,
        body,
      ),
    });
  }
  call(callee: Value, args: Value[], p: Position): Value {
    if (callee instanceof Callable) {
      if (callee.parameters.length !== args.length)
        this.fail(p, 'arguments', `${callee.name} expects ${callee.parameters.length} arguments.`);
      const scope = new Scope(callee.environment);
      callee.parameters.forEach((parameter, i) => {
        const value = args[i]!;
        if (parameter.annotation) this.check(value, parameter.annotation, p, parameter.name);
        scope.values.set(parameter.name, { value, annotation: parameter.annotation });
      });
      let result: Value = null;
      try {
        this.nested(p, () => callee.body(scope));
      } catch (error) {
        if (!(error instanceof Returned)) throw error;
        result = error.value;
      }
      if (callee.annotation) this.check(result, callee.annotation, p, `${callee.name} return`);
      return result;
    }
    if (!(callee instanceof Builtin)) return this.fail(p, 'type', 'This value is not callable.');
    const name = callee.name;
    if (primitiveNames.includes(name))
      return this.bounded(
        primitive(name, args, this.source, span(p), this.limits, (s, cost) =>
          this.tick([s.start, s.end], cost),
        ),
        p,
      );
    const arity = (count: number) => {
      if (args.length !== count) this.fail(p, 'arguments', `${name} expects ${count} arguments.`);
    };
    const value = args[0]!;
    if (name === 'COUNT') {
      arity(1);
      if (!(value instanceof List)) return this.fail(p, 'type', 'COUNT expects a list.');
      return this.bounded(BigInt(value.items.length), p);
    }
    if (name === 'APPEND') {
      arity(2);
      if (!(value instanceof List)) return this.fail(p, 'type', 'APPEND expects a list.');
      this.tick(p, value.items.length);
      if (value.items.length >= this.limits.singCollectionItems)
        this.fail(p, 'collection-limit', 'Sing collection is too large.');
      return this.list([...value.items, args[1]!], p);
    }
    if (name === 'TEXT') {
      arity(1);
      if (value !== null && typeof value === 'object')
        return this.fail(p, 'type', 'TEXT expects a scalar.');
      this.tick(p, integerCost(value) + (typeof value === 'string' ? value.length : 0));
      return this.bounded(String(value), p);
    }
    if (name === 'LENGTH') {
      arity(1);
      return this.bounded(BigInt(this.text(value, p).length), p);
    }
    if (name === 'CONTAINS') {
      arity(2);
      const haystack = this.text(value, p),
        needle = this.text(args[1]!, p);
      this.tick(p, haystack.length + needle.length);
      return haystack.includes(needle);
    }
    if (name === 'SLICE') {
      arity(3);
      const text = this.text(value, p),
        start = args[1]!,
        end = args[2]!;
      if (typeof start !== 'bigint' || typeof end !== 'bigint')
        return this.fail(p, 'type', 'SLICE bounds expect Int.');
      if (start < 0n || end < start || end > BigInt(text.length))
        return this.fail(p, 'index', 'SLICE bounds are out of range.');
      this.tick(p, Number(end - start));
      return this.bounded(text.slice(Number(start), Number(end)), p);
    }
    return this.fail(p, 'function', `Unknown function “${name}”.`);
  }
  block(scope: Scope, body: (scope: Scope) => void, p: Position): void {
    this.nested(p, () => body(new Scope(scope)));
  }
  items(value: Value, p: Position): readonly Value[] {
    if (!(value instanceof List)) return this.fail(p, 'type', 'FOR expects a list.');
    return value.items;
  }
  bind(scope: Scope, name: string, value: Value): void {
    scope.values.set(name, { value });
  }
  ret(value: Value): never {
    throw new Returned(value);
  }
  program(body: (scope: Scope) => void): Scalar {
    const scope = new Scope();
    for (const [name, value] of Object.entries(this.options.globals ?? {})) {
      if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value))
        throw new Error('Sing globals must be scalar values.');
      scope.values.set(name, { value: this.bounded(value, [0, 0]) });
    }
    try {
      this.nested([0, 0], () => body(scope));
    } catch (error) {
      if (!(error instanceof Returned)) throw error;
      if (error.value !== null && typeof error.value === 'object')
        return this.fail(
          [0, this.source.length],
          'type',
          'Top-level RETURN expects a scalar value.',
        );
      return error.value;
    }
    return this.fail(
      [this.source.length, this.source.length],
      'missing-result',
      'The script finished without a result.',
    );
  }
}
