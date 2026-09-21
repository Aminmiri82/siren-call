import { writeFile } from 'node:fs/promises';
import { compilerLimits } from '../selection.js';
import { compile, runCompiled } from './index.js';
import { readSource } from './files.js';

const usage =
  'Usage: sing:compile <input.sing> [-o output.mjs] [--run]\n       sing:compile --help';
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return;
  }
  const input = args.shift();
  if (!input || input.startsWith('-')) throw new Error(usage);
  let output: string | undefined;
  let run = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--run' && !run) run = true;
    else if (option === '-o' && !output) {
      output = args.shift();
      if (!output || output.startsWith('-') || !output.endsWith('.mjs'))
        throw new Error('Output must be an .mjs file.\n' + usage);
    } else throw new Error(usage);
  }
  const source = await readSource(input, compilerLimits.sourceBytes);
  const module = await compile(source);
  if (output) await writeFile(output, module, { flag: 'wx' });
  if (run) console.log(String(await runCompiled(module)));
  else if (!output) process.stdout.write(module);
}
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Compilation failed.');
  process.exitCode = 1;
}
