import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Validates a request part with a Zod schema; Glirastes reads the same schema as the tool contract. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ error: 'Invalid input' });
    return parsed.data;
  }
}
