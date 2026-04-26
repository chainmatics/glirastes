import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ChatMessagePartDto } from './chat-message-part.dto.js';

export class ChatMessageDto {
  @ApiPropertyOptional({ description: 'Unique message identifier' })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiProperty({
    description: 'The role of the message sender (e.g. user, assistant)',
  })
  @IsString()
  @IsNotEmpty()
  role!: string;

  @ApiPropertyOptional({ description: 'The text content of the message (legacy format)' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'Message parts in Vercel AI SDK UIMessage format',
    type: [ChatMessagePartDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ChatMessagePartDto)
  parts?: ChatMessagePartDto[];

  @Allow()
  metadata?: unknown;
}
