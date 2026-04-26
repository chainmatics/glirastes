import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ChatMessagePartDto {
  @ApiProperty({ description: 'The type of the message part (e.g. text, tool-invocation)' })
  @IsString()
  @IsNotEmpty()
  type!: string;

  @ApiPropertyOptional({ description: 'The text content of this part' })
  @IsString()
  @IsOptional()
  text?: string;

  @ApiPropertyOptional({ description: 'Streaming state of the part' })
  @IsString()
  @IsOptional()
  state?: string;

  @Allow()
  toolInvocation?: unknown;

  @Allow()
  toolCallId?: string;

  @Allow()
  toolName?: string;

  @Allow()
  input?: unknown;

  @Allow()
  output?: unknown;

  @Allow()
  approval?: unknown;

  @Allow()
  providerExecuted?: boolean;

  @Allow()
  callProviderMetadata?: unknown;

  @Allow()
  errorText?: string;

  @Allow()
  providerMetadata?: unknown;

  @Allow()
  data?: unknown;

  @Allow()
  source?: unknown;

  @Allow()
  mimeType?: unknown;

  @Allow()
  url?: unknown;
}
