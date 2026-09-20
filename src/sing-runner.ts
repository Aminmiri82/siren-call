import { Worker } from 'node:worker_threads';
import { limits } from './selection.js';
import type { CompileContext } from './selection.js';
import { SingError } from './sing/diagnostics.js';
import type { ExecutionResult } from './sing/types.js';

/** Resource-limited entry point for untrusted source; the synchronous core is an embedding API. */
export async function runSing(source: string, context?: CompileContext): Promise<ExecutionResult> {
  if (Buffer.byteLength(source) > limits.sourceBytes) throw new Error('Sing script is too large.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sing-worker.js', import.meta.url), {
      workerData: { source, context },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: limits.singHeapMb, stackSizeMb: 4 },
    });
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error, result?: ExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
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
        finish(event.diagnostic ? new SingError(event.diagnostic, source) : new Error(event.error));
      else finish(undefined, event.result);
    });
    worker.on('error', error =>
      finish(error instanceof Error ? error : new Error('Sing worker failed.')),
    );
    worker.on('exit', code => finish(new Error(`Sing worker exited without a result (${code}).`)));
  });
}
