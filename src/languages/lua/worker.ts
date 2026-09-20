import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { LuaFactory, LuaLibraries, LuaMultiReturn } from 'wasmoon';
import { resolveMember } from '../../members.js';
import { limits } from '../../selection.js';
import type { CompileContext } from '../../selection.js';

// Encode snapshots as plain Lua data; no JS object proxies enter Lua.
function literal(value: unknown): string {
  if (value === null) return 'nil';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string') {
    return (
      '"' + [...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('') + '"'
    );
  }
  if (Array.isArray(value)) return '{' + value.map(literal).join(',') + '}';
  if (typeof value === 'object' && value) {
    return (
      '{' +
      Object.entries(value)
        .map(([key, item]) => `[${literal(key)}]=${literal(item)}`)
        .join(',') +
      '}'
    );
  }
  throw new Error('Unsupported context value.');
}

const { source, context } = workerData as { source: string; context: CompileContext };
let engine;
try {
  engine = await new LuaFactory().createEngine({
    openStandardLibs: false,
    injectObjects: false,
    enableProxy: false,
    traceAllocations: true,
  });
  engine.global.setMemoryMax(limits.luaMemoryBytes);
  const allowed = [
    LuaLibraries.Base,
    LuaLibraries.Table,
    LuaLibraries.String,
    LuaLibraries.Math,
    LuaLibraries.UTF8,
  ];
  for (const library of allowed) engine.global.loadLibrary(library);
  // The only host callback: a string in, an ID or user-facing error out.
  engine.global.set('resolve_member', (reference: string) => {
    const values = new LuaMultiReturn();
    try {
      values.push(resolveMember(reference, context), undefined);
    } catch (error) {
      values.push(undefined, error instanceof Error ? error.message : 'Member lookup failed.');
    }
    return values;
  });
  const runtime = readFileSync(new URL('./runtime.lua', import.meta.url), 'utf8');
  parentPort!.postMessage({ ready: true });
  const prelude = `local source, context, limits = ${literal(source)}, ${literal(context)}, ${literal(limits)}`;
  const result = engine.doStringSync(`${prelude}\n${runtime}`) as { ids: string; message: string };
  parentPort!.postMessage({
    plan: { recipients: result.ids ? result.ids.split(',') : [], message: result.message },
  });
} catch (error) {
  const raw = error instanceof Error ? error.message : 'Lua execution failed.';
  // Prefer the user's chunk and line; omit the generated prelude and stack trace.
  const userError = raw.match(/\[string "siren"\]:(\d+):\s*([^\n]*)/);
  let message = userError
    ? `Line ${userError[1]}: ${userError[2]}`
    : raw.replace(/^.*?\]:(?:\d+):\s*/, '').split('\n')[0]!;
  if (/not enough memory|out of memory/i.test(raw)) {
    message = 'This script uses too much memory. Try a smaller selection or a simpler loop.';
  }
  if (message.includes("near '@'")) message += '\nPut names in quotes: member("@raphe22").';
  parentPort!.postMessage({ error: message.slice(0, 1500) });
} finally {
  engine?.global.close();
}
