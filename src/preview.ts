import { readFileSync } from 'node:fs';
import { LuaSelectionLanguage } from './languages/lua/index.js';
import { batches, permissionProblem, validatePlan } from './selection.js';
import type { CompileContext } from './selection.js';
const [script, fixture] = process.argv.slice(2);
if (!script || !fixture) throw new Error('Usage: npm run preview -- script.lua context.json');
const context = JSON.parse(readFileSync(fixture, 'utf8')) as CompileContext;
const plan = validatePlan(await new LuaSelectionLanguage().compile(readFileSync(script, 'utf8'), context), context);
console.log(JSON.stringify({ plan, messages: batches(plan).length, withoutMentionEveryone: permissionProblem(plan, context, false) ?? 'allowed' }, null, 2));
