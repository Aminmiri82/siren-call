import { SingSelectionLanguage } from './sing/index.js';
import { LuaSelectionLanguage } from './lua/index.js';
import type { SelectionLanguage } from '../selection.js';

/** Command choices and editor defaults live in the Discord layer; the CLI uses this registry. */
export const languages = new Map<string, SelectionLanguage>([
  ['lua', new LuaSelectionLanguage()],
  ['sing', new SingSelectionLanguage()],
]);

export const defaultLanguageId = 'lua';

export function language(id: string): SelectionLanguage {
  const selected = languages.get(id);
  if (!selected) throw new Error(`Unknown selection language: ${id}`);
  return selected;
}
