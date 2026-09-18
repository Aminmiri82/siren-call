import { Worker } from 'node:worker_threads';
import { limits } from '../../selection.js';
import type { CompileContext, PingPlan, SelectionLanguage } from '../../selection.js';

export class LuaSelectionLanguage implements SelectionLanguage {
  readonly id = 'lua';
  async compile(source: string, context: CompileContext): Promise<PingPlan> {
    if (Buffer.byteLength(source) > limits.sourceBytes) throw new Error('Lua script is too large.');
    return new Promise((resolve, reject) => {
      // An empty environment prevents the worker inheriting the bot token.
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { source, context }, env: {},
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
      });
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, plan?: PingPlan) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error); else resolve(plan!);
      };
      timer = setTimeout(() => finish(new Error('Lua runtime failed to start in time.')), limits.startupMs);
      worker.on('message', (event) => {
        if (event.ready) {
          clearTimeout(timer);
          timer = setTimeout(() => finish(new Error('Lua exceeded the 2-second execution limit.')), limits.executionMs);
        } else if (event.error) finish(new Error(event.error));
        else finish(undefined, event.plan);
      });
      worker.on('error', error => finish(error instanceof Error ? error : new Error('Lua worker failed.')));
      worker.on('exit', code => finish(new Error(`Lua worker exited without a result (${code}).`)));
    });
  }
}
