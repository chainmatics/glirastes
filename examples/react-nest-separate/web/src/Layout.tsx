import { Outlet } from 'react-router';
import { GlirastesBridge } from './glirastes-bridge';

export function Layout() {
  return (
    <main>
      <GlirastesBridge />
      <Outlet />
    </main>
  );
}
