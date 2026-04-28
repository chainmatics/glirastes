'use client';
import { VercelAiChat } from 'glirastes/react/vercel';
import 'glirastes/react/styles.css';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <VercelAiChat endpoint="/api/chat" />
    </>
  );
}
