import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { LuaFactory, LuaLibraries } from 'wasmoon';
import { limits } from '../../selection.js';
import type { CompileContext } from '../../selection.js';

// Encode plain data as Lua literals: no JS proxies or host callbacks enter Lua.
function literal(value: unknown): string {
  if (value === null) return 'nil';
  if (typeof value === 'string') return '"' + [...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('') + '"';
  if (Array.isArray(value)) return '{' + value.map(literal).join(',') + '}';
  if (typeof value === 'object' && value) return '{' + Object.entries(value).map(([key, item]) => `[${literal(key)}]=${literal(item)}`).join(',') + '}';
  throw new Error('Unsupported context value.');
}

const { source, context } = workerData as { source: string; context: CompileContext };
let engine;
try {
  engine = await new LuaFactory().createEngine({ openStandardLibs: false, injectObjects: false, enableProxy: false, traceAllocations: true });
  engine.global.setMemoryMax(limits.luaMemoryBytes);
  for (const library of [LuaLibraries.Base, LuaLibraries.Table, LuaLibraries.String, LuaLibraries.Math, LuaLibraries.UTF8]) engine.global.loadLibrary(library);
  const runtime = readFileSync(new URL('./runtime.lua', import.meta.url), 'utf8');
  parentPort!.postMessage({ ready: true });
  const result = engine.doStringSync(`local source, context = ${literal(source)}, ${literal(context)}\n${runtime}`) as { ids: string; message: string };
  parentPort!.postMessage({ plan: { recipients: result.ids ? result.ids.split(',') : [], message: result.message } });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message.slice(0, 1500) : 'Lua execution failed.' });
} finally {
  engine?.global.close();
}
