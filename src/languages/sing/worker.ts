import { parentPort, workerData } from 'node:worker_threads';
import type { CompileContext } from '../../selection.js';
import { SingError } from './diagnostics.js';
import { execute } from './runtime.js';

const { source, context } = workerData as { source: string; context: CompileContext };
parentPort!.postMessage({ ready: true });
try {
  parentPort!.postMessage({ plan: execute(source, context) });
} catch (error) {
  parentPort!.postMessage({
    diagnostic: error instanceof SingError ? error.diagnostic : undefined,
    error:
      error instanceof SingError ? error.message : 'Sing execution failed. Try a simpler script.',
  });
}
