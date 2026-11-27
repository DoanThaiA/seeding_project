import type { DispatchContext } from '@seedingsys/db';
import type { LlmGateway } from '@seedingsys/llm';
import type { Logger } from '@seedingsys/observability';

export interface CoreCtx extends DispatchContext {
  log: Logger;
  llm: LlmGateway;
}
