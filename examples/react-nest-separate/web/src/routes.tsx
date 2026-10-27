import { createBrowserRouter } from 'react-router';
import { Layout } from './Layout';
import { OverviewPage } from './pages/OverviewPage';
import { TasksPage } from './pages/TasksPage';

export const router = createBrowserRouter([
  {
    Component: Layout,
    children: [
      { path: '/tasks', Component: TasksPage },
      { path: '/overview', Component: OverviewPage },
    ],
  },
]);
