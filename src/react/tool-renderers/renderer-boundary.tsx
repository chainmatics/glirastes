import { Component, type ReactNode } from 'react';

interface RendererBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

/** A failing custom renderer degrades to the default tool result block. */
export class RendererBoundary extends Component<RendererBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
