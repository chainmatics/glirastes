<script lang="ts">
import { defineQueryFilters } from 'glirastes/browser';

/** The chat's ui.filter.tasks tool writes these URL parameters; the view reads them back. */
export const taskFilters = defineQueryFilters({ path: '/tasks', filters: { status: ['open', 'done'] } });
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { registerAiClientAction } from 'glirastes/browser';

interface Task {
  id: string;
  title: string;
  status: 'open' | 'done';
}

const route = useRoute();
const tasks = ref<Task[]>([]);
const highlighted = ref<string | null>(null);
const filters = computed(() => taskFilters.read(route.fullPath.split('?')[1] ?? ''));
const visible = computed(() => tasks.value.filter((task) => !filters.value.status || task.status === filters.value.status));

onMounted(async () => {
  const response = await fetch('/api/tasks', { credentials: 'include' });
  if (response.ok) tasks.value = ((await response.json()) as { tasks: Task[] }).tasks;
});

// Registered while the view is mounted; the chat cannot highlight a task elsewhere.
const unregister = registerAiClientAction('tasks.highlight', (payload: { title: string }) => {
  highlighted.value = payload.title;
});
onBeforeUnmount(unregister);
</script>

<template>
  <section aria-label="Tasks">
    <h1>Tasks</h1>
    <ul>
      <li v-for="task in visible" :key="task.id" :aria-current="task.title === highlighted ? 'true' : undefined">
        {{ task.title }}
      </li>
    </ul>
  </section>
</template>
