import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type SessionRequest } from '../auth/session.guard.js';
import { ZodValidationPipe } from '../validation/zod-validation.pipe.js';
import {
  createTaskInput,
  listTasksOutput,
  listTasksQuery,
  taskOutput,
  type CreateTaskInput,
  type ListTasksQuery,
} from './tasks.schemas.js';
import { tasksOf } from './tasks.store.js';

@Controller('tasks')
@UseGuards(SessionGuard)
export class TasksController {
  @Get()
  list(@Query(new ZodValidationPipe(listTasksQuery)) query: ListTasksQuery, @Req() request: SessionRequest) {
    const tasks = tasksOf(request.user!.subjectId).filter((task) => !query.status || task.status === query.status);
    return listTasksOutput.parse({ tasks });
  }

  @Post()
  create(@Body(new ZodValidationPipe(createTaskInput)) body: CreateTaskInput, @Req() request: SessionRequest) {
    const tasks = tasksOf(request.user!.subjectId);
    const task = { id: String(tasks.length + 1), title: body.title, status: 'open' as const };
    tasks.push(task);
    return taskOutput.parse(task);
  }
}
