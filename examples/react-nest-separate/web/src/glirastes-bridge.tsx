import { useNavigate } from 'react-router';
import { useGlirastesNavigationBridge } from 'glirastes/react';

/** Lets the chat open pages and set URL filters with the app's own router. */
export function GlirastesBridge() {
  const navigate = useNavigate();
  useGlirastesNavigationBridge({ push: (href: string) => navigate(href) });
  return null;
}
