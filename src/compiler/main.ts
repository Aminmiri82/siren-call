import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Scalar } from '../sing/types.js';

/** Imported generated modules are inert; direct Node execution prints their scalar result. */
export function runMain(url: string, run: () => Scalar): void {
  if (!process.argv[1] || pathToFileURL(realpathSync(process.argv[1])).href !== url) return;
  try {
    console.log(String(run()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Compiled Sing failed.');
    process.exitCode = 1;
  }
}
