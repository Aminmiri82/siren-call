import { Worker } from 'node:worker_threads';
import { compilerLimits, limits } from '../selection.js';
import { SingError } from '../sing/diagnostics.js';
import type { ExecutionLimits, Scalar } from '../sing/types.js';
import type { WorkerRequest } from './worker.js';
import { readSource } from './files.js';

export const runtimeURL = new URL('./runtime.js', import.meta.url).href;
export const compilerURL = new URL('./compiler.sing', import.meta.url);

function worker(request: WorkerRequest): Promise<Scalar> {
  const profile = request.profile === 'compiler' ? compilerLimits : limits;
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: request,
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: profile.singHeapMb, stackSizeMb: 8 },
    });
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error, value?: Scalar) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void child.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    timer = setTimeout(
      () => finish(new Error('Compiler worker failed to start in time.')),
      profile.startupMs,
    );
    child.on('message', event => {
      if (event.ready) {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new Error('Compiler worker exceeded the execution time limit.')),
          profile.executionMs,
        );
      } else if (event.error) {
        const error = event.diagnostic
          ? new SingError(event.diagnostic, '')
          : new Error(event.error);
        // The generating runtime has the target source; preserve its already-formatted excerpt.
        error.message = event.error;
        finish(error);
      } else finish(undefined, event.value);
    });
    child.on('error', error =>
      finish(error instanceof Error ? error : new Error('Compiler worker failed.')),
    );
    child.on('exit', code =>
      finish(new Error(`Compiler worker exited without a result (${code}).`)),
    );
  });
}
function checkInput(source: string): void {
  if (Buffer.byteLength(source) > compilerLimits.sourceBytes)
    throw new Error('Compiler source exceeds the source size limit.');
}
function output(value: Scalar): string {
  if (typeof value !== 'string') throw new Error('The compiler must return a JavaScript string.');
  if (value.length > compilerLimits.singStringLength)
    throw new Error('Generated module exceeds the output size limit.');
  return value;
}
async function compilerResult(source: string, action: () => Promise<Scalar>): Promise<string> {
  try {
    return output(await action());
  } catch (error) {
    if (error instanceof SingError && error.diagnostic.code === 'user-error') {
      const match = /^SING_COMPILER:(\d+):([\s\S]*)$/.exec(error.diagnostic.message);
      if (match) {
        const start = Number(match[1]);
        if (Number.isSafeInteger(start) && start <= source.length)
          throw new SingError(
            {
              code: 'compile-syntax',
              start,
              end: Math.min(start + 1, source.length),
              message: match[2]!,
            },
            source,
          );
      }
    }
    throw error;
  }
}
/** Stage zero runs the real Sing compiler through the existing interpreter. */
export async function compile(source: string): Promise<string> {
  checkInput(source);
  const program = await readSource(compilerURL, compilerLimits.sourceBytes);
  return compilerResult(source, () =>
    worker({
      mode: 'seed',
      program,
      globals: { SOURCE: source, RUNTIME: runtimeURL },
      profile: 'compiler',
    }),
  );
}
/** Execute trusted compiler-generated JS in a fresh bounded worker; this is not a JS sandbox. */
export function runCompiled(
  program: string,
  options: {
    globals?: Readonly<Record<string, Scalar>>;
    profile?: 'compiler' | 'standard';
    executionLimits?: ExecutionLimits;
  } = {},
): Promise<Scalar> {
  if (program.length > compilerLimits.singStringLength)
    throw new Error('Generated module exceeds the output size limit.');
  return worker({
    mode: 'generated',
    program,
    globals: options.globals ?? {},
    profile: options.profile ?? 'standard',
    executionLimits: options.executionLimits,
  });
}
export async function compileUsing(compiler: string, source: string): Promise<string> {
  checkInput(source);
  return compilerResult(source, () =>
    runCompiled(compiler, {
      profile: 'compiler',
      globals: { SOURCE: source, RUNTIME: runtimeURL },
    }),
  );
}
export async function bootstrap(): Promise<{ stage1: string; stage2: string; stage3: string }> {
  const source = await readSource(compilerURL, compilerLimits.sourceBytes);
  const stage1 = await compile(source);
  const stage2 = await compileUsing(stage1, source);
  const stage3 = await compileUsing(stage2, source);
  if (stage1 !== stage2 || stage2 !== stage3)
    throw new Error('Bootstrap did not stabilize: generated compiler stages differ.');
  return { stage1, stage2, stage3 };
}
