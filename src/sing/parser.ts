import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import type { NameLookup } from './types.js';

const keywords = new Set(
  'RETURN PING SAYING LET IF THEN ELSE END WHILE DO FOR IN AND OR XOR NOT TRUE FALSE NULL NONE CALLER MEMBERS MESSAGES COUNT MEMBER ROLE JOINED_AFTER CONTAINS TEXT'.split(
    ' ',
  ),
);
const keyword = (word: string) => word.replace(/[a-z]/g, letter => letter.toUpperCase());

interface Token extends Span {
  kind: string;
  text: string;
}
export type Expr = Span &
  (
    | { kind: 'literal'; value: string | bigint | number | boolean | null }
    | { kind: 'name'; name: string; reference: 'either' | 'member' | 'role' }
    | { kind: 'audience'; name: 'everyone' | 'here' }
    | { kind: 'variable'; name: string }
    | { kind: 'unary'; op: string; value: Expr }
    | { kind: 'binary'; op: string; left: Expr; right: Expr }
    | { kind: 'call'; name: string; args: Expr[] }
    | { kind: 'field'; value: Expr; field: string }
  );
export type Statement = Span &
  (
    | { kind: 'let' | 'assign'; name: string; value: Expr }
    | { kind: 'ping'; recipients: Expr; message: Expr }
    | { kind: 'return'; value: Expr }
    | { kind: 'if'; condition: Expr; yes: Statement[]; no: Statement[] }
    | { kind: 'while'; condition: Expr; body: Statement[] }
    | { kind: 'for'; name: string; collection: Expr; body: Statement[] }
  );

function lex(source: string, names: NameLookup): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const add = (kind: string, start: number, text = source.slice(start, i)) =>
    tokens.push({ kind, text, start, end: i });
  const string = (): string => {
    const start = i++;
    let escaped = false;
    while (i < source.length) {
      const c = source[i++]!;
      if (c === '\n' || c === '\r')
        fail(
          source,
          { start, end: i },
          'string',
          'Unclosed string. Use \\n for a newline inside a string.',
        );
      if (c === '"' && !escaped) {
        try {
          return JSON.parse(source.slice(start, i)) as string;
        } catch {
          fail(
            source,
            { start, end: i },
            'string',
            'Invalid string escape. Use JSON escapes such as \\" or \\n.',
          );
        }
      }
      escaped = c === '\\' && !escaped;
    }
    return fail(
      source,
      { start, end: i },
      'string',
      'Unclosed string. Add a closing double quote.',
    );
  };
  while (i < source.length) {
    const start = i;
    const c = source[i]!;
    if (c === '\n' || c === ';') {
      i++;
      add('separator', start);
      continue;
    }
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      const value = string();
      add('string', start, value);
      continue;
    }
    const mention = source.slice(i).match(/^<@(!|&)?(\d+)>/);
    if (mention) {
      i += mention[0].length;
      add(mention[1] === '&' ? 'role-ref' : 'member-ref', start, mention[2]!);
      continue;
    }
    if (c === '@') {
      i++;
      if (source[i] === '"') {
        const value = string();
        add('reference', start, value);
        continue;
      }
      const audience = source.slice(i).match(/^(?:everyone|here)(?=$|[\s;+\-()=<>!,"#@])/);
      if (audience) {
        i += audience[0].length;
        add('audience', start, audience[0]);
        continue;
      }
      const nameStart = i;
      while (i < source.length) {
        if (/[\n\r;+\-()=<>!,"#@]/u.test(source[i]!)) break;
        const word = source.slice(i).match(/^[\p{L}_][\p{L}\p{M}\p{N}_]*/u)?.[0];
        if ((i === nameStart || /\s/u.test(source[i - 1]!)) && word && keywords.has(keyword(word)))
          break;
        i += word ? word.length : 1;
      }
      const chunk = source.slice(nameStart, i).trimEnd();
      let matched = chunk;
      for (let end = chunk.length; end > 0; end--) {
        if (end < chunk.length && !/\s/u.test(chunk[end]!)) continue;
        const candidate = chunk.slice(0, end).trimEnd();
        if (names.has(candidate)) {
          matched = candidate;
          break;
        }
      }
      i = nameStart + matched.length;
      if (!matched)
        fail(
          source,
          { start, end: Math.min(source.length, i + 1) },
          'name',
          'Expected a name after @. Quote names containing syntax: @"name".',
        );
      add('reference', start, matched);
      continue;
    }
    const word = source.slice(i).match(/^[\p{L}_][\p{L}\p{M}\p{N}_]*/u)?.[0];
    if (word) {
      i += word.length;
      add(keywords.has(keyword(word)) ? keyword(word) : 'identifier', start, word);
      continue;
    }
    const number = source.slice(i).match(/^\d+(?:\.\d+)?/)?.[0];
    if (number) {
      i += number.length;
      add('number', start);
      continue;
    }
    const operator = source.slice(i).match(/^(?:==|!=|<=|>=|[+\-()=<>.,])/)?.[0];
    if (operator) {
      i += operator.length;
      add(operator, start);
      continue;
    }
    fail(source, { start, end: i + 1 }, 'character', `Unexpected character “${c}”.`);
  }
  tokens.push({ kind: 'eof', text: '', start: i, end: i });
  return tokens;
}

const precedence: Record<string, number> = {
  OR: 1,
  XOR: 2,
  '+': 3,
  '-': 3,
  AND: 4,
  '==': 5,
  '!=': 5,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
};

export function parse(source: string, names: NameLookup, depthLimit: number): Statement[] {
  const tokens = lex(source, names);
  let at = 0;
  let depth = 0;
  let grouping = 0;
  const current = () => tokens[at]!;
  const take = () => tokens[at++]!;
  const is = (kind: string) => current().kind === kind;
  const expect = (
    kind: string,
    message = `Expected ${kind}, found ${current().text || 'end of script'}.`,
  ) => {
    if (!is(kind)) fail(source, current(), 'syntax', message);
    return take();
  };
  const separators = () => {
    while (is('separator')) take();
  };
  const soft = () => {
    if (grouping) separators();
  };
  const nested = <T>(fn: () => T): T => {
    if (++depth > depthLimit)
      fail(
        source,
        current(),
        'depth-limit',
        'Sing nesting is too deep. Simplify this expression or block.',
      );
    try {
      return fn();
    } finally {
      depth--;
    }
  };
  function expression(min = 0): Expr {
    return nested(() => {
      soft();
      const token = take();
      let left: Expr;
      if (token.kind === 'string' || token.kind === 'number')
        left = {
          ...token,
          kind: 'literal',
          value:
            token.kind === 'string'
              ? token.text
              : token.text.includes('.')
                ? Number(token.text)
                : BigInt(token.text),
        };
      else if (['TRUE', 'FALSE', 'NULL'].includes(token.kind))
        left = {
          ...token,
          kind: 'literal',
          value: token.kind === 'NULL' ? null : token.kind === 'TRUE',
        };
      else if (token.kind === 'audience')
        left = { ...token, kind: 'audience', name: token.text as 'everyone' | 'here' };
      else if (['reference', 'member-ref', 'role-ref'].includes(token.kind))
        left = {
          ...token,
          kind: 'name',
          name: token.text,
          reference:
            token.kind === 'reference' ? 'either' : token.kind === 'role-ref' ? 'role' : 'member',
        };
      else if (token.kind === 'NOT' || token.kind === '-') {
        const value = expression(6);
        left = { ...token, end: value.end, kind: 'unary', op: token.kind, value };
      } else if (token.kind === '(') {
        grouping++;
        left = expression();
        soft();
        expect(')');
        grouping--;
      } else if (
        token.kind === 'identifier' ||
        [
          'NONE',
          'CALLER',
          'MEMBERS',
          'MESSAGES',
          'COUNT',
          'MEMBER',
          'ROLE',
          'JOINED_AFTER',
          'CONTAINS',
          'TEXT',
        ].includes(token.kind)
      ) {
        const name = token.kind === 'identifier' ? token.text : token.kind;
        if (is('(')) {
          take();
          grouping++;
          soft();
          const args: Expr[] = [];
          if (!is(')')) {
            for (;;) {
              args.push(expression());
              soft();
              if (!is(',')) break;
              take();
            }
          }
          const end = expect(')').end;
          grouping--;
          left = { ...token, end, kind: 'call', name, args };
        } else left = { ...token, kind: 'variable', name };
      } else
        return fail(
          source,
          token,
          'expression',
          `Expected an expression, found ${token.text || 'end of script'}. Use @ before recipient names.`,
        );
      while (true) {
        soft();
        if (is('.')) {
          take();
          const field = expect('identifier', 'Expected a record field after the dot.');
          left = {
            start: left.start,
            end: field.end,
            kind: 'field',
            value: left,
            field: field.text,
          };
          continue;
        }
        const op = current();
        const power = precedence[op.kind];
        if (power === undefined || power < min) break;
        take();
        const right = expression(power + 1);
        left = { start: left.start, end: right.end, kind: 'binary', op: op.kind, left, right };
      }
      return left;
    });
  }
  function block(stops: string[]): Statement[] {
    return nested(() => {
      const result: Statement[] = [];
      separators();
      while (!is('eof') && !stops.includes(current().kind)) {
        result.push(statement());
        if (!is('eof') && !stops.includes(current().kind) && !is('separator'))
          fail(
            source,
            current(),
            'separator',
            'Expected a newline or semicolon between statements.',
          );
        separators();
      }
      return result;
    });
  }
  function statement(): Statement {
    const token = take();
    const span = () => ({ start: token.start, end: tokens[at - 1]!.end });
    if (token.kind === 'LET' || token.kind === 'identifier') {
      const name =
        token.kind === 'LET'
          ? expect(
              'identifier',
              'Expected a variable name after LET; keywords are reserved regardless of case.',
            ).text
          : token.text;
      expect('=', 'Expected = for assignment.');
      const value = expression();
      return { ...span(), kind: token.kind === 'LET' ? 'let' : 'assign', name, value };
    }
    if (token.kind === 'RETURN') {
      const value = expression();
      return { ...span(), kind: 'return', value };
    }
    if (token.kind === 'PING') {
      const recipients = expression();
      expect('SAYING', 'Expected SAYING followed by a message.');
      const message = expression();
      return { ...span(), kind: 'ping', recipients, message };
    }
    if (token.kind === 'IF') {
      const condition = expression();
      expect('THEN');
      const yes = block(['ELSE', 'END']);
      let no: Statement[] = [];
      if (is('ELSE')) {
        take();
        no = block(['END']);
      }
      expect('END', 'Missing END for IF.');
      return { ...span(), kind: 'if', condition, yes, no };
    }
    if (token.kind === 'WHILE') {
      const condition = expression();
      expect('DO');
      const body = block(['END']);
      expect('END', 'Missing END for WHILE.');
      return { ...span(), kind: 'while', condition, body };
    }
    if (token.kind === 'FOR') {
      const name = expect('identifier').text;
      expect('IN');
      const collection = expression();
      expect('DO');
      const body = block(['END']);
      expect('END', 'Missing END for FOR.');
      return { ...span(), kind: 'for', name, collection, body };
    }
    return fail(
      source,
      token,
      'statement',
      'Expected LET, IF, FOR, WHILE, an assignment, RETURN, or PING.',
    );
  }
  return block([]);
}
