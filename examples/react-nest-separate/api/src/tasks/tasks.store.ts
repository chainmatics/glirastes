import type { Task } from './tasks.schemas.js';

// Reference data per user; a real app reads its database here.
const tasks = new Map<string, Task[]>();

export function tasksOf(subjectId: string): Task[] {
  let list = tasks.get(subjectId);
  if (!list) {
    list = [
      { id: '1', title: 'Write tests', status: 'open' },
      { id: '2', title: 'Ship the fixture', status: 'done' },
    ];
    tasks.set(subjectId, list);
  }
  return list;
}
