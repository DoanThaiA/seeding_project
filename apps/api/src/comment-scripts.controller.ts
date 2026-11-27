import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { activeKillSwitch, audit, lockCommentScript, queueCommentScriptStep, tx, type Db, type Tx } from '@seedingsys/db';
import { facebookScriptComment, facebookScriptPost, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const id = z.string().uuid();
const fingerprint = z.number().int().positive();
const scriptInput = z.object({ name: z.string().trim().min(1).max(120), postUrl: z.string().trim().max(2000), steps: z.array(z.object({
  targetId: id, text: z.string().trim().min(1).max(8000).transform(text => text.replace(/\r\n?/g, '\n')),
  replyTo: z.number().int().min(0).nullable().default(null), replyUrl: z.string().trim().max(2000).nullable().default(null),
})).min(1).max(50) });

function readInput(body: unknown) {
  const input = parse(scriptInput, body);
  const post = facebookScriptPost(input.postUrl);
  if (!post) throw new BadRequestException('Dán liên kết trực tiếp hoặc liên kết chia sẻ đến một bài Facebook.');
  const steps = input.steps.map((step, position) => {
    if (step.replyTo !== null && (step.replyTo >= position || step.replyUrl)) {
      throw new BadRequestException(`Bước ${position + 1} cần trả lời một bước đứng trước hoặc một bình luận có sẵn.`);
    }
    const reply = facebookScriptComment(step.replyUrl);
    if (step.replyUrl && (!reply || (post.id && reply.postId !== post.id))) {
      throw new BadRequestException(`Liên kết bình luận ở bước ${position + 1} phải thuộc bài đang chọn.`);
    }
    return { ...step, replyUrl: reply?.url.href ?? null, position };
  });
  return { name: input.name, postUrl: post.url.href, resolvedUrl: post.id ? post.url.href : null, steps };
}

@Controller('comment-scripts')
export class CommentScriptsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  list() {
    return this.db.commentScript.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: {
      id: true, name: true, startedAt: true, steps: { select: { status: true } },
    } });
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const script = await this.db.commentScript.findUnique({ where: { id }, include: { steps: { orderBy: { position: 'asc' },
      include: { target: { select: { code: true, name: true } } } } } });
    if (!script) throw new NotFoundException('Không tìm thấy kịch bản.');
    return script;
  }

  @Post()
  @Roles('operator')
  async create(@Body() body: unknown, @Actor() actor: Principal) {
    const { steps, ...input } = readInput(body);
    return tx(this.db, async t => {
      await this.assertTargets(t, steps);
      const now = this.clock.now();
      const script = await t.commentScript.create({ data: { ...input, createdAt: now, steps: { createMany: { data: steps } } } });
      await audit(t, { entityType: 'comment_script', entityId: script.id, action: 'created', actor: actor.actor, at: now });
      return { id: script.id };
    });
  }

  @Put(':id')
  @Roles('operator')
  async edit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { version } = parse(z.object({ version: fingerprint }), body);
    const { steps, ...input } = readInput(body);
    return tx(this.db, async t => {
      await this.lockDraft(t, id, version);
      await this.assertTargets(t, steps);
      await t.commentScriptStep.deleteMany({ where: { scriptId: id } });
      const script = await t.commentScript.update({ where: { id }, data: { ...input, version: { increment: 1 }, steps: { createMany: { data: steps } } } });
      await audit(t, { entityType: 'comment_script', entityId: id, action: 'edited', actor: actor.actor, at: this.clock.now() });
      return { id, version: script.version };
    });
  }

  @Post(':id/start')
  @Roles('operator')
  async start(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { version } = parse(z.object({ version: fingerprint }), body);
    return tx(this.db, async t => {
      await this.lockDraft(t, id, version);
      const steps = await t.commentScriptStep.findMany({ where: { scriptId: id }, select: { targetId: true } });
      await this.assertTargets(t, steps, true);
      const now = this.clock.now();
      if (!await queueCommentScriptStep(t, id, now)) throw new ConflictException('Chưa có bước để chạy.');
      await t.commentScript.update({ where: { id }, data: { startedAt: now } });
      await audit(t, { entityType: 'comment_script', entityId: id, action: 'started', actor: actor.actor, at: now });
      return { queued: true };
    });
  }

  @Post(':id/steps/:stepId/resolve')
  @Roles('operator')
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Param('stepId', ParseUUIDPipe) stepId: string,
    @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.discriminatedUnion('action', [
      z.object({ action: z.literal('retry'), sendVersion: fingerprint, checkedMissing: z.boolean().default(false) }),
      z.object({ action: z.literal('confirm'), sendVersion: fingerprint, permalink: z.string().trim().max(2000) }),
    ]), body);
    return tx(this.db, async t => {
      await lockCommentScript(t, id);
      const script = await t.commentScript.findUnique({ where: { id } });
      const step = await t.commentScriptStep.findFirst({ where: { scriptId: id, status: { not: 'POSTED' } }, orderBy: { position: 'asc' } });
      if (!script?.startedAt || step?.id !== stepId || step.sendVersion !== input.sendVersion || !['FAILED', 'UNKNOWN'].includes(step.status)) {
        throw new ConflictException('Bước hiện tại đã thay đổi. Hãy tải lại kịch bản.');
      }
      const now = this.clock.now();
      if (input.action === 'retry') {
        if (step.status === 'UNKNOWN' && !input.checkedMissing) throw new ConflictException('Cần xác nhận trên Facebook rằng bình luận chưa được đăng.');
        await this.assertTargets(t, [step], true);
        if (!await queueCommentScriptStep(t, id, now, step.id)) throw new ConflictException('Bước đã đổi trạng thái.');
      } else {
        if (step.status !== 'UNKNOWN') throw new ConflictException('Chỉ xác nhận liên kết cho một bước chưa rõ kết quả.');
        const post = script.resolvedUrl && facebookScriptPost(script.resolvedUrl);
        const receipt = facebookScriptComment(input.permalink);
        const parent = step.replyTo === null ? null : await t.commentScriptStep.findUnique({ where: { scriptId_position: { scriptId: id, position: step.replyTo } } });
        const parentLink = facebookScriptComment(parent?.permalink ?? step.replyUrl);
        if (!post || !receipt || receipt.postId !== post.id || ((step.replyTo !== null || step.replyUrl)
          ? !parentLink || receipt.root !== parentLink.root || !receipt.reply || receipt.id === parentLink.id
          : !!receipt.reply)) {
          throw new BadRequestException('Liên kết phải là bình luận mới đúng bài và đúng nhánh trả lời.');
        }
        if (await t.commentScriptStep.findFirst({ where: { scriptId: id, externalId: receipt.id } })) {
          throw new ConflictException('Liên kết bình luận này đã được ghi nhận ở một bước khác.');
        }
        const saved = await t.commentScriptStep.updateMany({ where: { id: step.id, status: 'UNKNOWN', sendVersion: step.sendVersion },
          data: { status: 'POSTED', externalId: receipt.id, permalink: receipt.url.href, detail: 'Đã đối chiếu thủ công.', updatedAt: now } });
        if (!saved.count) throw new ConflictException('Bước đã đổi trạng thái.');
        await queueCommentScriptStep(t, id, now);
      }
      await audit(t, { entityType: 'comment_script', entityId: id, action: input.action, actor: actor.actor, at: now, data: { stepId } });
      return { saved: true };
    });
  }

  private async lockDraft(t: Tx, id: string, version: number) {
    await lockCommentScript(t, id);
    const script = await t.commentScript.findUnique({ where: { id } });
    if (!script) throw new NotFoundException('Không tìm thấy kịch bản.');
    if (script.startedAt || script.version !== version) throw new ConflictException('Kịch bản đã thay đổi hoặc đã được chạy. Hãy tải lại.');
  }

  private async assertTargets(t: Tx, steps: { targetId: string }[], checkPause = false) {
    const ids = [...new Set(steps.map(step => step.targetId))];
    const targets = await t.targetAccount.findMany({ where: { id: { in: ids }, enabled: true, connector: 'fb-web', profile: { isNot: null } },
      select: { id: true, code: true } });
    if (targets.length !== ids.length) throw new ConflictException('Chọn hồ sơ B đang bật và đã cấu hình phiên Facebook cho từng bước.');
    if (checkPause) for (const target of targets) {
      if (await activeKillSwitch(t, { targetId: target.id, connector: 'fb-web' })) throw new ConflictException(`Hồ sơ ${target.code} đang tạm dừng.`);
    }
  }
}
