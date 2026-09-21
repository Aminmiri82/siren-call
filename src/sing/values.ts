import type { Statement, Parameter, TypeExpr } from './parser.js';
import type { Scalar } from './types.js';

export type Value = Scalar | Set<string> | ListValue | RecordValue | FunctionValue | BuiltinValue;
export interface ListValue {
  kind: 'list';
  items: readonly Value[];
  depth: number;
}
export interface RecordValue {
  kind: 'record';
  fields: ReadonlyMap<string, Value>;
  hidden?: ReadonlySet<string>;
  depth: number;
}
export interface FunctionValue {
  kind: 'function';
  name: string;
  parameters: (Parameter & { resolved?: TypeExpr })[];
  resultType?: TypeExpr;
  body: Statement[];
  environment: Scope;
}
export interface BuiltinValue {
  kind: 'builtin';
  name: string;
}
export interface Binding {
  value: Value;
  annotation?: TypeExpr;
}
export class Scope {
  readonly values = new Map<string, Binding>();
  readonly types = new Map<string, TypeExpr>();
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
      const type = scope.types.get(name);
      if (type) return type;
    }
    return undefined;
  }
}
export function tagged<K extends 'list' | 'record' | 'function' | 'builtin'>(
  value: Value,
  kind: K,
): value is Extract<Value, { kind: K }> {
  return (
    value !== null && typeof value === 'object' && !(value instanceof Set) && value.kind === kind
  );
}
