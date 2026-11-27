import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { SyncedProfileDetails } from '@seedingsys/contracts';
import { Prisma, audit, tx, type Db } from '@seedingsys/db';
import type { Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const selection = { id: true, code: true, name: true } as const;
const members = z.array(z.string().uuid()).max(500).transform(ids => [...new Set(ids)]);
const groupInput = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).default(''),
  sourceIds: members, targetIds: members });

@Controller('profile-groups')
export class ProfileGroupsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  async list(@Actor() actor: Principal) {
    const [groups, sources, targets] = await Promise.all([
      this.db.profileGroup.findMany({ orderBy: { name: 'asc' }, include: {
        sources: { select: { id: true } }, targets: { select: { id: true } },
      } }),
      this.db.source.findMany({ orderBy: { code: 'asc' }, select: selection }),
      this.db.targetAccount.findMany({ orderBy: { code: 'asc' }, select: { ...selection, enabled: true, connector: true,
        profile: { select: { id: true } }, externalId: true, profileDetails: actor.role === 'admin' } }),
    ]);
    return { groups: groups.map(({ sources, targets, ...group }) => ({ ...group,
      sourceIds: sources.map(row => row.id), targetIds: targets.map(row => row.id) })), sources,
      targets: targets.map(({ profileDetails, externalId, profile, connector, enabled, ...target }) => {
        const parsed = SyncedProfileDetails.safeParse(profileDetails);
        return { ...target, canComment: enabled && connector === 'fb-web' && !!profile,
          details: parsed.success && parsed.data.targetExternalId === externalId ? parsed.data : null };
      }) };
  }

  @Post()
  @Roles('operator')
  create(@Body() body: unknown, @Actor() actor: Principal) {
    return this.save(undefined, body, actor);
  }

  @Put(':id')
  @Roles('operator')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    return this.save(id, body, actor);
  }

  private async save(id: string | undefined, body: unknown, actor: Principal) {
    const { name, description, sourceIds, targetIds } = parse(groupInput, body);
    const sources = sourceIds.map(id => ({ id }));
    const targets = targetIds.map(id => ({ id }));
    try {
      return await tx(this.db, async t => {
        if (id) {
          const rows = await t.$queryRaw<{ id: string }[]>`SELECT id FROM profile_groups WHERE id=${id}::uuid FOR UPDATE`;
          if (!rows.length) throw new NotFoundException('Không tìm thấy nhóm.');
        }
        const [sourceCount, targetCount] = await Promise.all([
          t.source.count({ where: { id: { in: sourceIds } } }), t.targetAccount.count({ where: { id: { in: targetIds } } }),
        ]);
        if (sourceCount !== sources.length || targetCount !== targets.length) throw new ConflictException('Có hồ sơ đã bị gỡ khỏi hệ thống.');
        const group = id
          ? await t.profileGroup.update({ where: { id }, data: { name, description, sources: { set: sources }, targets: { set: targets } } })
          : await t.profileGroup.create({ data: { name, description, sources: { connect: sources }, targets: { connect: targets } } });
        await audit(t, { entityType: 'profile_group', entityId: group.id, action: id ? 'updated' : 'created', actor: actor.actor,
          at: this.clock.now(), data: { sourceIds, targetIds } });
        return group;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Tên nhóm đã tồn tại.');
      throw error;
    }
  }
}
