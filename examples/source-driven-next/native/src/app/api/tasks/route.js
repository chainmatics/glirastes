import { inputSchema, outputSchema } from './contract.js';
import { query } from '../../../query.js';

const tasks = [
  { id: '1', title: 'Review release', status: 'open', owner: 'alice' },
  { id: '2', title: 'Write tests', status: 'done', owner: 'alice' },
  { id: '3', title: 'Private task', status: 'open', owner: 'bob' },
];

export async function GET(request) {
  return query(request, inputSchema, outputSchema, (input, principal) => ({
    tasks: tasks.filter((task) => task.owner === principal.subjectId
      && (!input.status || task.status === input.status)),
  }));
}
