export interface Span {
  start: number;
  end: number;
}

export interface Diagnostic extends Span {
  code: string;
  message: string;
  suggestions?: string[];
}

export class SingError extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    source: string,
  ) {
    const { start, end, message, suggestions } = diagnostic;
    const prefix = source.slice(0, start);
    const line = prefix.split('\n').length;
    const lineStart = prefix.lastIndexOf('\n') + 1;
    const column = Array.from(source.slice(lineStart, start)).length + 1;
    const lineEnd = source.indexOf('\n', start);
    // Keep Discord's error response useful even for a very long one-line script.
    const excerptStart = Math.max(lineStart, start - 60);
    const excerptEnd = Math.min(lineEnd < 0 ? source.length : lineEnd, start + 100);
    const excerpt = source.slice(excerptStart, excerptEnd).replace(/\t/g, ' ');
    const indent = Array.from(source.slice(excerptStart, start)).length;
    const width = Math.max(1, Array.from(source.slice(start, Math.min(end, excerptEnd))).length);
    super(
      `Line ${line}, column ${column}: ${message}\n\n${excerpt}\n${' '.repeat(indent)}${'^'.repeat(width)}` +
        (suggestions?.length ? `\n\nDid you mean ${suggestions.join(' or ')}?` : ''),
    );
    this.name = 'SingError';
  }
}

export function fail(source: string, span: Span, code: string, message: string): never {
  throw new SingError({ ...span, code, message }, source);
}
