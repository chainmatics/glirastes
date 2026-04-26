import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ChatMessageDto } from './chat-message.dto.js';

export class AiChatRequestDto {
  @ApiPropertyOptional({ description: 'Unique chat session identifier sent by the Vercel AI SDK transport' })
  @IsString()
  @IsOptional()
  id?: string;

  @ApiProperty({
    description: 'Chat messages in Vercel AI SDK UIMessage format',
    type: [ChatMessageDto],
  })
  @IsArray()
  @IsNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages!: ChatMessageDto[];

  @ApiPropertyOptional({ description: 'Trigger type: submit-message or regenerate-message' })
  @IsString()
  @IsOptional()
  trigger?: string;

  @ApiPropertyOptional({ description: 'ID of the message to regenerate (for regenerate-message trigger)' })
  @IsString()
  @IsOptional()
  messageId?: string;
}
