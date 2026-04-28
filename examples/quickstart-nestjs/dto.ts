import { IsOptional, IsString } from 'class-validator';
import { AiParam } from 'glirastes/server/nestjs';

export class ListTasksQueryDto {
  @IsString()
  @IsOptional()
  @AiParam('Optional status filter, one of "open" | "done".')
  status?: 'open' | 'done';
}
