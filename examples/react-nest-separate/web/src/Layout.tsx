import { Outlet } from 'react-router';
import { GlirastesBridge } from './glirastes-bridge';

export function Layout() {
  return (
    <main>
      <GlirastesBridge />
      <Outlet />
      <glirastes-chat endpoint="/api/chat" theme="light" placeholder="Ask about your tasks" />
    </main>
  );
}
