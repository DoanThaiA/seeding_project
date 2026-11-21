import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import type { Principal } from './auth';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal);

/** JSON-safe output (BigInt → string). */
export function out<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
