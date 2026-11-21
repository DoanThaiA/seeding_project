import type { Db } from '@seedingsys/db';
import { hashObject, vnDay, type Clock } from '@seedingsys/domain';
import { PROMPT_VERSION } from './prompts';
import { LlmBudgetExceededError, type LlmEditor, type RewriteInput, type RewriteOutput, type Usage } from './types';

/** USD per million tokens (input, output). Unknown models are priced conservatively. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [2, 10],
  'fake-editor': [0, 0],
};

export function costMicroUsd(u: Usage): bigint {
  const [i, o] = PRICES[u.modelId] ?? [10, 50];
  return BigInt(Math.ceil(u.inputTokens * i + u.outputTokens * o)); // tokens × $/MTok = µ$
}

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * The only path to the LLM. Holds the key (core server only), enforces the daily budget and
 * concurrency, records usage, and caches results by (revision, target config, prompt, model).
 */
export class LlmGateway {
  private readonly sem: Semaphore;

  constructor(
    private readonly db: Db,
    private readonly editor: LlmEditor,
    private readonly clock: Clock,
    private readonly opts: { dailyBudgetUsd: number; maxConcurrency: number; profile?: string },
  ) {
    this.sem = new Semaphore(opts.maxConcurrency);
  }

  cacheKey(revisionId: string, targetStyle: unknown): string {
    return hashObject({ revisionId, targetStyle, prompt: PROMPT_VERSION, model: this.editor.modelId });
  }

  async spentTodayMicroUsd(): Promise<bigint> {
    const r = await this.db.llmUsage.aggregate({
      where: { profile: this.opts.profile ?? 'editor', day: vnDay(this.clock.now()) },
      _sum: { costMicroUsd: true },
    });
    return r._sum.costMicroUsd ?? 0n;
  }

  async rewrite(input: RewriteInput & { revisionId: string; variantId: string }): Promise<{ output: RewriteOutput; cacheKey: string; cached: boolean }> {
    const key = this.cacheKey(input.revisionId, input.targetStyle);
    const hit = await this.db.llmCache.findUnique({ where: { cacheKey: key } });
    if (hit) return { output: hit.output as unknown as RewriteOutput, cacheKey: key, cached: true };

    const budget = BigInt(Math.round(this.opts.dailyBudgetUsd * 1_000_000));
    if ((await this.spentTodayMicroUsd()) >= budget) throw new LlmBudgetExceededError('daily LLM budget exhausted');

    const { output, usage } = await this.sem.run(() => this.editor.rewrite(input));
    const now = this.clock.now();
    await this.db.llmUsage.createMany({
      data: usage.map((u) => ({
        profile: this.opts.profile ?? 'editor',
        modelId: u.modelId,
        day: vnDay(now),
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costMicroUsd: costMicroUsd(u),
        refType: 'variant',
        refId: input.variantId,
        at: now,
      })),
    });
    await this.db.llmCache.upsert({
      where: { cacheKey: key },
      create: { cacheKey: key, output: output as object, modelId: output.model_id },
      update: {},
    });
    return { output, cacheKey: key, cached: false };
  }
}
