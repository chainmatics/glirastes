'use client';
import { useRouter } from 'next/navigation';
import { useGlirastesNavigationBridge } from 'glirastes/react';

/** Lets the chat open pages and set URL filters with the app's own router. */
export function GlirastesBridge() {
  const router = useRouter();
  useGlirastesNavigationBridge({ push: (href) => router.push(href) });
  return null;
}
