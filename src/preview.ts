import { readFileSync } from 'node:fs';
import { defaultLanguageId, language } from './languages/index.js';
import { batches, permissionProblem, validatePlan } from './selection.js';
import type { CompileContext } from './selection.js';

const [script, fixture, languageId = defaultLanguageId] = process.argv.slice(2);
if (!script || !fixture) {
  throw new Error('Usage: pnpm run preview <script.lua> <context.json> [language]');
}
const context = JSON.parse(readFileSync(fixture, 'utf8')) as CompileContext;
const compiled = await language(languageId).compile(readFileSync(script, 'utf8'), context);
const plan = validatePlan(compiled, context);
console.log(
  JSON.stringify(
    {
      plan,
      messages: batches(plan).length,
      withoutMentionEveryone: permissionProblem(plan, context, false) ?? 'allowed',
    },
    null,
    2,
  ),
);
