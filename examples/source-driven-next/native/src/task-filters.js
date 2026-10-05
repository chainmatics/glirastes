import { defineQueryFilters } from 'glirastes/browser';

/** The URL filters of the tasks page; the page and the chat use the same definition. */
export const taskFilters = defineQueryFilters({
  path: '/tasks',
  filters: { status: ['open', 'done'] },
});
