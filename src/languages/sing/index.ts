import { Worker } from 'node:worker_threads';
import { limits } from '../../selection.js';
import type { CompileContext, PingPlan, SelectionLanguage } from '../../selection.js';
import { SingError } from './diagnostics.js';

export { SingError } from './diagnostics.js';

export class SingSelectionLanguage implements SelectionLanguage {
  readonly id = 'sing';
  async compile(source: string, context: CompileContext): Promise<PingPlan> {
    if (Buffer.byteLength(source) > limits.sourceBytes)
      throw new Error('Sing script is too large.');
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { source, context },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: limits.singHeapMb, stackSizeMb: 4 },
      });
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (error?: Error, plan?: PingPlan) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(plan!);
      };
      timer = setTimeout(
        () => finish(new Error('Sing worker failed to start in time.')),
        limits.startupMs,
      );
      worker.on('message', event => {
        if (event.ready) {
          clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error('Sing exceeded the execution time limit.')),
            limits.executionMs,
          );
        } else if (event.error)
          finish(
            event.diagnostic ? new SingError(event.diagnostic, source) : new Error(event.error),
          );
        else finish(undefined, event.plan);
      });
      worker.on('error', error =>
        finish(error instanceof Error ? error : new Error('Sing worker failed.')),
      );
      worker.on('exit', code =>
        finish(new Error(`Sing worker exited without a result (${code}).`)),
      );
    });
  }
}
