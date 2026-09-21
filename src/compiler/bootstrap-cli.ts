import { mkdir, writeFile } from 'node:fs/promises';
import { bootstrap, compileUsing, runCompiled } from './index.js';

try {
  if (process.argv.length > 2) throw new Error('Usage: sing:bootstrap');
  const stages = await bootstrap();
  for (const [source, expected] of [
    ['RETURN 9007199254740992 + 1;', 9007199254740993n],
    [
      'FUNC make(n: Int) { FUNC add(x: Int): Int { RETURN x + n; } RETURN add; } RETURN make(10)(32);',
      42n,
    ],
    ['TYPE T = {value: Int}; LET xs: List<T> = [{value: 42}]; RETURN xs[0].value;', 42n],
  ] as const) {
    for (const stage of [stages.stage1, stages.stage2, stages.stage3]) {
      const result = await runCompiled(await compileUsing(stage, source));
      if (result !== expected) throw new Error('Bootstrapped compiler failed a behavior check.');
    }
  }
  const directory = new URL('../bootstrap/', import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const [name, code] of Object.entries(stages))
    await writeFile(new URL(`${name}.mjs`, directory), code);
  console.log('Bootstrap passed: stages 1, 2, and 3 are byte-for-byte identical.');
  console.log('All three compilers passed integer, closure, and annotation behavior checks.');
  console.log(`Generated compilers: ${directory.pathname}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
  process.exitCode = 1;
}
