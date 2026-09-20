import type { Span } from './diagnostics.js';

export type Scalar = string | bigint | number | boolean | null;
export type RecordValue = { [key: string]: Scalar | string[] };
export type Value = Scalar | Set<string> | RecordValue | RecordValue[];
export interface NameLookup {
  has(name: string): boolean;
}
export interface ExecutionLimits {
  sourceBytes: number;
  singSteps: number;
  singDepth: number;
  singStringLength: number;
  singIntegerDigits: number;
}
export interface Plan {
  recipients: string[];
  message: string;
}
export type ExecutionResult = { kind: 'return'; value: Scalar } | { kind: 'ping'; value: Plan };
export interface HostServices {
  tick(span: Span, cost?: number): void;
  text(value: Value, span: Span): string;
  fail(span: Span, code: string, message: string): never;
}
/** Trusted embedding code; scripts cannot supply callbacks or obtain this object. */
export interface SelectionHost {
  names: NameLookup;
  audience(name: 'everyone' | 'here', span: Span, services: HostServices): Set<string>;
  resolve(
    name: string,
    kind: 'either' | 'member' | 'role',
    span: Span,
    services: HostServices,
  ): Set<string>;
  variable(name: string): Value | undefined;
  call(name: string, args: Value[], span: Span, services: HostServices): Value | undefined;
  records(ids: Set<string>, span: Span, services: HostServices): RecordValue[];
  ping(plan: Plan, span: Span, services: HostServices): Plan;
}
export interface ExecutionOptions {
  limits: ExecutionLimits;
  host?: SelectionHost;
}
