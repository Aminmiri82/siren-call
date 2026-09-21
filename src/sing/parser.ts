import { fail } from './diagnostics.js';
import type { Span } from './diagnostics.js';
import type { NameLookup } from './types.js';

const keywords = new Set(
  'RETURN PING SAYING LET IF THEN ELSE END WHILE DO FOR IN FUNC TYPE AND OR XOR NOT TRUE FALSE NULL NONE CALLER MEMBERS MESSAGES COUNT MEMBER ROLE JOINED_AFTER CONTAINS TEXT APPEND LENGTH SLICE INT CHAR_CODE CHAR ERROR'.split(
    ' ',
  ),
);
const keyword = (word: string) => word.replace(/[a-z]/g, letter => letter.toUpperCase());

export type TypeExpr = Span &
  (
    | { kind: 'named'; name: string }
    | { kind: 'list'; element: TypeExpr }
    | { kind: 'record'; fields: { name: string; type: TypeExpr }[] }
  );
export interface Parameter extends Span {
  name: string;
  annotation?: TypeExpr;
}

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
    | { kind: 'call'; callee: Expr; args: Expr[] }
    | { kind: 'list'; items: Expr[] }
    | { kind: 'record'; fields: { name: string; value: Expr }[] }
    | { kind: 'index'; value: Expr; index: Expr }
    | { kind: 'field'; value: Expr; field: string }
  );
export type Statement = Span &
  (
    | { kind: 'let' | 'assign'; name: string; value: Expr; annotation?: TypeExpr }
    | {
        kind: 'func';
        name: string;
        parameters: Parameter[];
        annotation?: TypeExpr;
        body: Statement[];
      }
    | { kind: 'type'; name: string; value: TypeExpr }
    | { kind: 'expression'; value: Expr }
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
      const audience = source.slice(i).match(/^(?:everyone|here)(?=$|[\s;+\-()=<>!,"#@{}[\]:])/);
      if (audience) {
        i += audience[0].length;
        add('audience', start, audience[0]);
        continue;
      }
      const nameStart = i;
      while (i < source.length) {
        if (/[\n\r;+\-()=<>!,"#@{}[\]:]/u.test(source[i]!)) break;
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
    const operator = source.slice(i).match(/^(?:==|!=|<=|>=|[+\-()=<>.,{}[\]:])/)?.[0];
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
  function unique(identifiers: string[], span: Span) {
    if (new Set(identifiers).size !== identifiers.length)
      fail(source, span, 'duplicate-name', 'Duplicate field or parameter name.');
  }
  function fieldName(): string {
    const token = take();
    if (token.kind !== 'identifier' && token.kind !== 'string')
      fail(source, token, 'syntax', 'Expected a field name or quoted string.');
    return token.text;
  }
  function commaList<T>(end: string, item: () => T): T[] {
    const items: T[] = [];
    soft();
    while (!is(end)) {
      items.push(item());
      soft();
      if (!is(',')) break;
      take();
      soft();
    }
    return items;
  }
  function typeExpression(): TypeExpr {
    return nested(() => {
      soft();
      const token = take();
      if (token.kind === '{') {
        grouping++;
        const fields = commaList('}', () => {
          const name = fieldName();
          expect(':');
          return { name, type: typeExpression() };
        });
        unique(
          fields.map(field => field.name),
          token,
        );
        const end = expect('}').end;
        grouping--;
        return { ...token, end, kind: 'record', fields };
      }
      if (token.kind !== 'identifier' && token.kind !== 'NULL' && token.kind !== 'INT')
        return fail(source, token, 'syntax', 'Expected a type name.');
      if (token.text === 'List') {
        expect('<');
        grouping++;
        const element = typeExpression();
        soft();
        const end = expect('>').end;
        grouping--;
        return { ...token, end, kind: 'list', element };
      }
      return {
        ...token,
        kind: 'named',
        name: token.kind === 'NULL' ? 'Null' : token.kind === 'INT' ? 'Int' : token.text,
      };
    });
  }
  function annotation(): TypeExpr | undefined {
    if (!is(':')) return undefined;
    take();
    return typeExpression();
  }
  function braced(): Statement[] {
    expect('{');
    // Statement newlines stay significant even inside a surrounding call or list.
    const outerGrouping = grouping;
    grouping = 0;
    const body = block(['}']);
    expect('}', 'Missing } for block.');
    grouping = outerGrouping;
    return body;
  }
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
      } else if (token.kind === '[') {
        grouping++;
        const items = commaList(']', () => expression());
        const end = expect(']').end;
        grouping--;
        left = { ...token, end, kind: 'list', items };
      } else if (token.kind === '{') {
        grouping++;
        const fields = commaList('}', () => {
          const name = fieldName();
          expect(':');
          return { name, value: expression() };
        });
        unique(
          fields.map(field => field.name),
          token,
        );
        const end = expect('}').end;
        grouping--;
        left = { ...token, end, kind: 'record', fields };
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
          'APPEND',
          'LENGTH',
          'SLICE',
          'INT',
          'CHAR_CODE',
          'CHAR',
          'ERROR',
        ].includes(token.kind)
      ) {
        const name = token.kind === 'identifier' ? token.text : token.kind;
        left = { ...token, kind: 'variable', name };
      } else
        return fail(
          source,
          token,
          'expression',
          `Expected an expression, found ${token.text || 'end of script'}. Use @ before recipient names.`,
        );
      while (true) {
        soft();
        if (is('(')) {
          take();
          grouping++;
          const args = commaList(')', () => expression());
          const end = expect(')').end;
          grouping--;
          left = { start: left.start, end, kind: 'call', callee: left, args };
          continue;
        }
        if (is('[')) {
          take();
          grouping++;
          const index = expression();
          soft();
          const end = expect(']').end;
          grouping--;
          left = { start: left.start, end, kind: 'index', value: left, index };
          continue;
        }
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
        const item = statement();
        result.push(item);
        const closedBlock =
          ['func', 'if', 'while', 'for'].includes(item.kind) && tokens[at - 1]!.kind === '}';
        if (!closedBlock && !is('eof') && !stops.includes(current().kind) && !is('separator'))
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
    if (token.kind === 'FUNC') {
      const name = expect('identifier', 'Expected a function name after FUNC.').text;
      expect('(');
      grouping++;
      const parameters = commaList(')', (): Parameter => {
        const parameter = expect('identifier', 'Expected a parameter name.');
        return { ...parameter, name: parameter.text, annotation: annotation() };
      });
      expect(')');
      grouping--;
      unique(
        parameters.map(parameter => parameter.name),
        token,
      );
      const resultType = annotation();
      let body: Statement[];
      if (is('{')) body = braced();
      else {
        expect('DO', 'Expected { or DO for a function body.');
        body = block(['END']);
        expect('END', 'Missing END for FUNC.');
      }
      return { ...span(), kind: 'func', name, parameters, annotation: resultType, body };
    }
    if (token.kind === 'TYPE') {
      const name = is('INT')
        ? (take(), 'Int')
        : expect('identifier', 'Expected a type alias name.').text;
      expect('=');
      const value = typeExpression();
      return { ...span(), kind: 'type', name, value };
    }
    if (token.kind === 'LET' || (token.kind === 'identifier' && is('='))) {
      const name =
        token.kind === 'LET'
          ? expect(
              'identifier',
              'Expected a variable name after LET; keywords are reserved regardless of case.',
            ).text
          : token.text;
      const declaredType = token.kind === 'LET' ? annotation() : undefined;
      expect('=', 'Expected = for assignment.');
      const value = expression();
      return {
        ...span(),
        kind: token.kind === 'LET' ? 'let' : 'assign',
        name,
        value,
        annotation: declaredType,
      };
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
      if (is('{')) {
        const yes = braced();
        // Allow ELSE on the following line without consuming the next statement's separator.
        const after = at;
        separators();
        let no: Statement[] = [];
        if (is('ELSE')) {
          take();
          no = braced();
        } else at = after;
        return { ...span(), kind: 'if', condition, yes, no };
      }
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
      const body = is('{') ? braced() : legacyBody('WHILE');
      return { ...span(), kind: 'while', condition, body };
    }
    if (token.kind === 'FOR') {
      const name = expect('identifier').text;
      expect('IN');
      const collection = expression();
      const body = is('{') ? braced() : legacyBody('FOR');
      return { ...span(), kind: 'for', name, collection, body };
    }
    at--;
    const value = expression();
    if (is('='))
      fail(
        source,
        current(),
        'immutable',
        'Lists and records are immutable; assign a new value to a variable.',
      );
    return { ...span(), kind: 'expression', value };
  }
  function legacyBody(kind: string): Statement[] {
    expect('DO');
    const body = block(['END']);
    expect('END', `Missing END for ${kind}.`);
    return body;
  }

  return block([]);
}
