import { LuaSelectionLanguage } from './lua/index.js';
import type { SelectionLanguage } from '../selection.js';

/** Add an adapter here and the bot, the editor modal, and `pnpm run preview` all pick it up. */
export const languages = new Map<string, SelectionLanguage>([['lua', new LuaSelectionLanguage()]]);

export const defaultLanguageId = 'lua';

export function language(id: string): SelectionLanguage {
  const selected = languages.get(id);
  if (!selected) throw new Error(`Unknown selection language: ${id}`);
  return selected;
}
