'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAiClientAction } from 'glirastes/react';
import { taskFilters } from '../../../task-filters.js';
import { highlightTask } from '../../../ui-contracts.js';

function Tasks() {
  const router = useRouter();
  const filters = taskFilters.read(useSearchParams());
  const [tasks, setTasks] = useState([]);
  const [highlighted, setHighlighted] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/tasks', { signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Start an authenticated reference session first.');
      const body = await response.json();
      if (!abort.signal.aborted) setTasks(body.tasks);
    }).catch((failure) => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, []);
  /** Highlights one task of the visible list by its title. */
  useAiClientAction('tasks.highlight', (payload) => setHighlighted(payload.title), highlightTask);
  const visible = tasks.filter((task) => !filters.status || task.status === filters.status);
  return (
    <section data-testid="native-ui" aria-label="Native application">
      <h1>Tasks</h1>
      <label>
        Status
        <select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(event) => router.push(taskFilters.href(event.target.value ? { status: event.target.value } : {}))}
        >
          <option value="">All</option>
          <option value="open">open</option>
          <option value="done">done</option>
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      <ul>
        {visible.map((task) => (
          <li key={task.id} aria-current={task.title === highlighted ? 'true' : undefined}>{task.title}</li>
        ))}
      </ul>
    </section>
  );
}

export default function TasksPage() {
  return <Suspense><Tasks /></Suspense>;
}
