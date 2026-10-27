import { useEffect, useState } from 'react';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useAiClientAction } from 'glirastes/react';
import { highlightTask } from '../ui-contracts';

interface Task {
  id: string;
  title: string;
  status: 'open' | 'done';
}

export function TasksPage() {
  const [status, setStatus] = useQueryState('status', parseAsStringLiteral(['open', 'done'] as const));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [highlighted, setHighlighted] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/tasks', { signal: abort.signal, credentials: 'include' })
      .then(async (response) => { if (response.ok) setTasks((await response.json() as { tasks: Task[] }).tasks); })
      .catch(() => undefined);
    return () => abort.abort();
  }, []);
  /** Highlights one task of the visible list by its title. */
  useAiClientAction('tasks.highlight', (payload: { title: string }) => setHighlighted(payload.title), highlightTask);
  const visible = tasks.filter((task) => !status || task.status === status);
  return (
    <section aria-label="Tasks">
      <h1>Tasks</h1>
      <select aria-label="Status" value={status ?? ''} onChange={(event) => void setStatus(event.target.value === 'open' || event.target.value === 'done' ? event.target.value : null)}>
        <option value="">All</option>
        <option value="open">open</option>
        <option value="done">done</option>
      </select>
      <ul>
        {visible.map((task) => (
          <li key={task.id} aria-current={task.title === highlighted ? 'true' : undefined}>{task.title}</li>
        ))}
      </ul>
    </section>
  );
}
