import { Controller, Get, Query } from '@nestjs/common';
import { AiModule, AiTool } from 'glirastes/server/nestjs';
import { ListTasksQueryDto } from './dto.js';

@Controller('tasks')
@AiModule({
  intent: 'task_management',
  classification: {
    hint: 'User asks about listing or filtering tasks.',
    examples: ['show me open tasks', 'what is done?', 'list my tasks'],
  },
})
export class TaskController {
  @Get()
  @AiTool({
    name: 'list_tasks',
    description: 'List tasks with an optional status filter.',
  })
  list(@Query() q: ListTasksQueryDto) {
    return [{ id: '1', title: 'Demo', status: q.status ?? 'open' }];
  }
}
