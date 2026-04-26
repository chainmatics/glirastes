// glirastes — main entry point
//
// Re-exports all shared types, interfaces, and helpers that live in `types.ts`
// so consumers can do `import { ModuleMeta, defineUiTool } from 'glirastes'`.
// Subpath exports (`glirastes/server`, `glirastes/react`, etc.) remain the
// primary API surface for runtime functionality.
export * from './types.js';
