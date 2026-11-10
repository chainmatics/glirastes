import { createRouter, createWebHistory } from 'vue-router';
import OverviewView from './views/OverviewView.vue';
import TasksView from './views/TasksView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/tasks' },
    { path: '/overview', component: OverviewView },
    { path: '/tasks', component: TasksView },
  ],
});
