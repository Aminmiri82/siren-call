import { parentPort, workerData } from 'node:worker_threads';
import { limits } from './selection.js';
import type { CompileContext } from './selection.js';
import { execute } from './sing/index.js';
import { execute as select } from './languages/sing/runtime.js';
import { SingError } from './sing/diagnostics.js';

const { source, context } = workerData as { source: string; context?: CompileContext };
parentPort!.postMessage({ ready: true });
try {
  const result =
    context === undefined
      ? execute(source, { limits })
      : { kind: 'ping', value: select(source, context) };
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({
    diagnostic: error instanceof SingError ? error.diagnostic : undefined,
    error:
      error instanceof SingError ? error.message : 'Sing execution failed. Try a simpler script.',
  });
}
