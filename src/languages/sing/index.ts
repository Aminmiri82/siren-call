import type { CompileContext, PingPlan, SelectionLanguage } from '../../selection.js';
import { runSing } from '../../sing-runner.js';

export { SingError } from '../../sing/diagnostics.js';

export class SingSelectionLanguage implements SelectionLanguage {
  readonly id = 'sing';
  async compile(source: string, context: CompileContext): Promise<PingPlan> {
    const result = await runSing(source, context);
    if (result.kind !== 'ping') throw new Error('Expected a Sing selection plan.');
    return result.value;
  }
}
