// packages/cli/src/utils/gap-detector.test.ts
import { describe, it, expect } from 'vitest';
import { detectGaps, type Gap } from './gap-detector.js';
import type { ChangelogEntry } from './changelog-parser.js';

describe('detectGaps', () => {
  it('should detect missing relatedModules usage', () => {
    const entries: ChangelogEntry[] = [
      {
        version: '0.7.2',
        date: '2025-03-05',
        added: [
          { description: 'relatedModules generated from tool overlap', package: 'codegen' },
        ],
        fixed: [],
        breaking: [],
      },
    ];

    const codebase = `
      import { defineModule } from 'glirastes/server';

      export const taskModule = defineModule({
        id: 'task_query',
        name: 'Task Query',
        tools: ['list_tasks'],
      });
    `;

    const gaps = detectGaps(entries, codebase);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].type).toBe('missing-feature');
    expect(gaps[0].feature).toBe('relatedModules');
    expect(gaps[0].changelogItem.description).toContain('relatedModules');
  });

  it('should return no gaps if feature is used', () => {
    const entries: ChangelogEntry[] = [
      {
        version: '0.7.2',
        date: '2025-03-05',
        added: [
          { description: 'relatedModules generated', package: 'codegen' },
        ],
        fixed: [],
        breaking: [],
      },
    ];

    const codebase = `
      export const taskModule = defineModule({
        id: 'task_query',
        relatedModules: ['task_mutation'],
      });
    `;

    const gaps = detectGaps(entries, codebase);

    expect(gaps).toHaveLength(0);
  });

  it('should detect breaking change usage', () => {
    const entries: ChangelogEntry[] = [
      {
        version: '1.0.0',
        date: '2025-03-10',
        added: [],
        fixed: [],
        breaking: [
          { description: 'ModelTier.FAST renamed to ModelTier.Fast', package: 'ai-router' },
        ],
      },
    ];

    const codebase = `
      import { ModelTier } from 'glirastes';
      const tier = ModelTier.FAST;
    `;

    const gaps = detectGaps(entries, codebase);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].type).toBe('breaking-change');
    expect(gaps[0].affectsUser).toBe(true);
  });

  it('should not report breaking changes that do not affect user', () => {
    const entries: ChangelogEntry[] = [
      {
        version: '1.0.0',
        date: '2025-03-10',
        added: [],
        fixed: [],
        breaking: [
          { description: 'ModelTier.FAST renamed to ModelTier.Fast', package: 'ai-router' },
        ],
      },
    ];

    const codebase = `
      import { ModelTier } from 'glirastes';
      const tier = ModelTier.Fast;
    `;

    const gaps = detectGaps(entries, codebase);

    expect(gaps).toHaveLength(0);
  });
});
