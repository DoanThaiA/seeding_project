import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AppConfig } from '@seedingsys/config';
import { COMMENT_GENERATION_MS, COMMENT_PREVIEW_KIND, COMMENT_PREVIEW_MS, CommentPostSnapshot, GeneratedCommentDraft, Q } from '@seedingsys/contracts';
import { activeKillSwitch, enqueue, tx, type Db } from '@seedingsys/db';
import { facebookScriptPost, type Clock } from '@seedingsys/domain';
import { z } from 'zod';
import { Roles } from './auth';
import { CLOCK, CONFIG, DB } from './tokens';
import { parse } from './util';

const previewInput = z.object({ targetId: z.string().uuid(), postUrl: z.string().trim().max(2000) });
const generationInput = z.object({ request: z.string().trim().min(1).max(2000) });

@Controller('comment-scripts/post-previews')
@Roles('operator')
export class CommentPreviewsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig) {}

  @Post()
  async create(@Body() body: unknown) {
    const { targetId, postUrl } = parse(previewInput, body);
    const post = facebookScriptPost(postUrl);
    if (!post) throw new BadRequestException('Dán liên kết trực tiếp hoặc liên kết chia sẻ đến một bài Facebook.');
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${targetId}::uuid FOR UPDATE`;
      const target = await t.targetAccount.findFirst({ where: { id: targetId, enabled: true, connector: 'fb-web', profile: { isNot: null } } });
      if (!target) throw new ConflictException('Chọn tài khoản B đang bật và đã cấu hình phiên Facebook.');
      if (await activeKillSwitch(t, { targetId, connector: 'fb-web' })) throw new ConflictException('Tài khoản B đang tạm dừng.');
      const now = this.clock.now();
      const active = await t.targetBrowserRun.findFirst({ where: { targetId, kind: COMMENT_PREVIEW_KIND,
        status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { gt: new Date(+now - COMMENT_PREVIEW_MS) } } });
      if (active?.profileUrl === post.url.href) return { id: active.id };
      if (active) throw new ConflictException('Tài khoản B này đang lấy một bài khác. Thử lại khi lượt hiện tại hoàn tất.');
      const run = await t.targetBrowserRun.create({ data: { targetId, kind: COMMENT_PREVIEW_KIND, profileUrl: post.url.href, createdAt: now } });
      await enqueue(t, Q.TargetBrowser, { runId: run.id });
      return { id: run.id };
    });
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.db.targetBrowserRun.findFirst({ where: { id, kind: COMMENT_PREVIEW_KIND } });
    if (!run) throw new NotFoundException('Không tìm thấy lượt lấy bài.');
    const post = CommentPostSnapshot.safeParse(run.results).data;
    if (run.status === 'DONE' && post) {
      // Ảnh base64 chỉ dùng cho LLM, không gửi về trình duyệt.
      const { images, ...rest } = post;
      return { status: 'DONE', post: { ...rest, previewId: id, imageCount: images.length } };
    }
    if (run.status === 'FAILED' || run.status === 'DONE' || +this.clock.now() - +run.createdAt >= COMMENT_PREVIEW_MS) {
      return { status: 'FAILED', error: run.message ?? 'Lượt lấy bài đã hết thời gian hoặc chưa có nội dung xác nhận.' };
    }
    return { status: run.status };
  }

  @Post(':id/generations')
  async generate(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { request } = parse(generationInput, body);
    if (this.config.LLM_MODE === 'fake') {
      throw new ConflictException('Máy chủ đang ở chế độ LLM giả lập. Cần cấu hình Claude trên worker-core để tạo bằng AI.');
    }
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM target_browser_runs WHERE id = ${id}::uuid FOR UPDATE`;
      const run = await t.targetBrowserRun.findFirst({ where: { id, kind: COMMENT_PREVIEW_KIND, status: 'DONE' } });
      if (!run || !CommentPostSnapshot.safeParse(run.results).success) throw new ConflictException('Hãy lấy nội dung bài trước khi tạo kịch bản bằng AI.');
      const now = this.clock.now();
      const active = await t.commentScriptGeneration.findFirst({ where: { previewId: id, status: { in: ['QUEUED', 'RUNNING'] },
        createdAt: { gt: new Date(+now - COMMENT_GENERATION_MS) } } });
      if (active?.request === request) return { id: active.id };
      if (active) throw new ConflictException('AI đang tạo kịch bản cho bài này.');
      const generation = await t.commentScriptGeneration.create({ data: { previewId: id, request, createdAt: now } });
      await enqueue(t, Q.CommentScriptGenerate, { generationId: generation.id });
      return { id: generation.id };
    });
  }

  @Get(':id/generations/:generationId')
  async getGeneration(@Param('id', ParseUUIDPipe) id: string, @Param('generationId', ParseUUIDPipe) generationId: string) {
    const generation = await this.db.commentScriptGeneration.findFirst({ where: { id: generationId, previewId: id } });
    if (!generation) throw new NotFoundException('Không tìm thấy lượt tạo kịch bản.');
    const draft = GeneratedCommentDraft.safeParse(generation.result).data;
    if (generation.status === 'DONE' && draft) return { status: 'DONE', draft };
    if (generation.status === 'FAILED' || generation.status === 'DONE' || +this.clock.now() - +generation.createdAt >= COMMENT_GENERATION_MS) {
      return { status: 'FAILED', error: generation.error ?? 'Lượt tạo kịch bản đã hết thời gian hoặc chưa có kết quả.' };
    }
    return { status: generation.status };
  }
}
