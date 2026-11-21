export * from './types';
export * from './prompts';
export * from './gateway';
export * from './fake';
export { ClaudeEditor } from './claude';

import { ClaudeEditor } from './claude';
import { FakeEditor } from './fake';
import type { LlmEditor } from './types';

export function createEditor(cfg: {
  LLM_MODE: 'fake' | 'claude';
  ANTHROPIC_API_KEY?: string;
  LLM_EDITOR_MODEL: string;
  LLM_MAX_OUTPUT_TOKENS: number;
  LLM_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}): LlmEditor {
  if (cfg.LLM_MODE === 'fake') return new FakeEditor();
  return new ClaudeEditor(cfg.LLM_EDITOR_MODEL, { apiKey: cfg.ANTHROPIC_API_KEY, maxTokens: cfg.LLM_MAX_OUTPUT_TOKENS, effort: cfg.LLM_EFFORT });
}
