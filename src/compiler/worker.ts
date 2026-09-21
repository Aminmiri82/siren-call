import { parentPort, workerData } from 'node:worker_threads';
import { execute } from '../sing/index.js';
import { SingError } from '../sing/diagnostics.js';
import { compilerLimits, limits } from '../selection.js';
import type { ExecutionLimits, Scalar } from '../sing/types.js';

export interface WorkerRequest {
  mode: 'seed' | 'generated';
  program: string;
  globals: Readonly<Record<string, Scalar>>;
  profile: 'compiler' | 'standard';
  executionLimits?: ExecutionLimits;
}
const request = workerData as WorkerRequest;
parentPort!.postMessage({ ready: true });
try {
  const options = {
    limits: request.executionLimits ?? (request.profile === 'compiler' ? compilerLimits : limits),
    globals: request.globals,
  };
  let value: Scalar;
  if (request.mode === 'seed') {
    const result = execute(request.program, options);
    if (result.kind !== 'return') throw new Error('The compiler must RETURN generated JavaScript.');
    value = result.value;
  } else {
    // Only the standalone toolchain executes generated modules; the bot never uses this worker.
    const module = await import(
      'data:text/javascript;base64,' + Buffer.from(request.program).toString('base64')
    );
    value = module.default(options);
  }
  if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value))
    throw new Error('Compiled Sing must return a scalar.');
  parentPort!.postMessage({ value });
} catch (error) {
  parentPort!.postMessage({
    diagnostic: error instanceof SingError ? error.diagnostic : undefined,
    error: error instanceof Error ? error.message : 'Compiler worker failed.',
  });
}
