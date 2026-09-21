import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import type { ExecutionLimits, Scalar } from './types.js';

export const primitiveNames = ['INT', 'CHAR_CODE', 'CHAR', 'ERROR'];

/** Scalar-only operations shared by the interpreter and generated-code runtime. */
export function primitive(
  name: string,
  args: unknown[],
  source: string,
  span: Span,
  limits: ExecutionLimits,
  tick: (span: Span, cost?: number) => void,
): Scalar {
  if (args.length !== 1) fail(source, span, 'arguments', `${name} expects 1 argument.`);
  const value = args[0];
  if (name === 'CHAR') {
    if (typeof value !== 'bigint') fail(source, span, 'type', 'CHAR expects an Int.');
    if (value < 0n || value > 65535n)
      fail(source, span, 'character', 'CHAR expects a UTF-16 code unit from 0 to 65535.');
    return String.fromCharCode(Number(value));
  }
  if (typeof value !== 'string') fail(source, span, 'type', `${name} expects a String.`);
  tick(span, value.length);
  if (name === 'ERROR') return fail(source, span, 'user-error', value);
  if (name === 'CHAR_CODE') {
    if (value.length !== 1)
      fail(source, span, 'character', 'CHAR_CODE expects exactly one UTF-16 code unit.');
    return BigInt(value.charCodeAt(0));
  }
  if (!/^[+-]?\d+$/.test(value)) fail(source, span, 'number', 'INT expects signed decimal digits.');
  const digits = value.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  if (digits.length > limits.singIntegerDigits)
    fail(source, span, 'integer-limit', 'Sing integer is too large.');
  return BigInt(value);
}
