import { open } from 'node:fs/promises';
import { limits } from './selection.js';
import { runSing } from './sing-runner.js';

const usage = 'Usage: sing [--json] <script.sing>\n       sing --help';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(usage);
    return;
  }
  const json = args[0] === '--json';
  if (json) args.shift();
  if (args.length !== 1 || args[0]!.startsWith('-')) throw new Error(usage);
  const file = await open(args[0]!, 'r');
  let source: string;
  try {
    // Bound reads as well as execution, including files whose reported size changes.
    const bytes = Buffer.alloc(limits.sourceBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limits.sourceBytes) throw new Error('Sing script is too large.');
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
  const result = await runSing(source);
  if (result.kind !== 'return') throw new Error('Standalone scripts must RETURN a scalar value.');
  const value = result.value;
  if (json) {
    const type =
      value === null
        ? 'null'
        : typeof value === 'bigint'
          ? 'integer'
          : typeof value === 'number'
            ? 'decimal'
            : typeof value;
    console.log(JSON.stringify({ type, value: typeof value === 'bigint' ? String(value) : value }));
  } else {
    console.log(String(value));
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Sing failed.');
  process.exitCode = 1;
}
