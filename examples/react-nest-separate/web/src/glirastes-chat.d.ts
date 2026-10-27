import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// <glirastes-chat> from glirastes/embed, registered in main.tsx.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'glirastes-chat': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        endpoint: string;
        theme?: string;
        placeholder?: string;
      };
    }
  }
}
