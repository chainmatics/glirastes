import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';
import { router } from './routes';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NuqsAdapter>
      <RouterProvider router={router} />
    </NuqsAdapter>
  </StrictMode>,
);
