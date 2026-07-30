import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createRouteSourceFingerprint,
  scanNextAppRoutes,
  writeNextAppRouteScan,
} from './route-scanner.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'glirastes-route-scan-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
  return rootDir;
}

describe('scanNextAppRoutes', () => {
  it('discovers route structure and evidence without auto-approving GET', async () => {
    const rootDir = await fixture({
      'src/app/api/tasks/[id]/route.ts': `
        import { getSession } from '@/lib/auth/session';
        import { updateTaskSchema } from '@/lib/validations/task';

        export async function GET(request: Request) {
          await getSession();
          const { searchParams } = new URL(request.url);
          searchParams.get('include');
          searchParams.getAll('status');
        }

        export async function PATCH(request: Request) {
          await getSession();
          const body = await request.json();
          return updateTaskSchema.safeParse(body);
        }
      `,
    });

    const result = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      method: 'GET',
      path: '/api/tasks/:id',
      pathParams: ['id'],
      queryParams: [
        { name: 'include', repeated: false },
        { name: 'status', repeated: true },
      ],
      authEvidence: ['getSession'],
      riskClass: 'unknown',
      autoApprovalEligible: false,
      reviewReasons: ['data-classification-unverified'],
    });
    expect(result.candidates[1]).toMatchObject({
      method: 'PATCH',
      path: '/api/tasks/:id',
      schemaBindings: [{
        symbol: 'updateTaskSchema',
        module: '@/lib/validations/task',
      }],
      riskClass: 'write',
      autoApprovalEligible: false,
      reviewReasons: ['write-operation'],
    });
    expect(result.candidates.every((candidate) =>
      /^sha256:[A-Za-z0-9_-]+$/.test(candidate.sourceFingerprint)))
      .toBe(true);
  });

  it('extracts evidence after typed destructured route parameters', async () => {
    const rootDir = await fixture({
      'src/app/api/tasks/[id]/route.ts': `
        import { getSession } from '@/lib/auth/session';

        export async function GET(
          request: Request,
          { params }: { params: Promise<{ id: string }> },
        ) {
          await getSession();
          const { searchParams } = new URL(request.url);
          searchParams.get('include');
          return Response.json({ params });
        }
      `,
    });

    const result = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
    });

    expect(result.candidates[0]).toMatchObject({
      authEvidence: ['getSession'],
      queryParams: [{ name: 'include', repeated: false }],
      reviewReasons: ['data-classification-unverified'],
    });
  });

  it('flags missing auth and external calls and respects explicit ignores', async () => {
    const rootDir = await fixture({
      'src/app/api/public/route.ts': `
        export async function GET() {
          return fetch('https://example.com/data');
        }
      `,
      'src/app/api/internal/route.ts': `
        // @ai-ignore
        export async function POST() {
          return new Response('ok');
        }
      `,
    });

    const result = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      path: '/api/public',
      authEvidence: [],
      externalCallEvidence: ['fetch'],
      reviewReasons: [
        'auth-boundary-unverified',
        'external-call-detected',
        'data-classification-unverified',
      ],
    });
    expect(result.ignored).toEqual([
      'src/app/api/internal/route.ts',
    ]);
  });

  it('keeps ignore comments confined to explicit legacy mode', async () => {
    const source = `
      // @ai-ignore
      export async function GET() { return Response.json([]); }
    `;
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts': source,
    });

    const legacy = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
      mode: 'legacy-route-scan',
    });
    const foundation = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
      mode: 'foundation-inventory',
      inventory: {
        schemaVersion: 2,
        targetAppKey: 'fixture',
        executions: [{
          toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1e0001',
          definitionId: 'tasks.list',
          stableKey: 'GET /api/tasks',
          executionKind: 'endpoint',
          sourceFile: 'src/app/api/tasks/route.ts',
          sourceFingerprint: createRouteSourceFingerprint(
            source,
            'GET',
            '/api/tasks',
          ),
          inputSchemaDigest: `sha256:${'A'.repeat(43)}`,
          outputSchemaDigest: `sha256:${'B'.repeat(43)}`,
          method: 'GET',
          path: '/api/tasks',
        }],
      },
    });

    expect(legacy.candidates).toHaveLength(0);
    expect(foundation.candidates).toHaveLength(1);
    expect(foundation.ignored).toEqual([]);
  });

  it('changes the source fingerprint when route code changes', async () => {
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts':
        'export async function GET() { return new Response("one"); }',
    });

    const first = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
    });
    await writeFile(
      join(rootDir, 'src/app/api/tasks/route.ts'),
      'export async function GET() { return new Response("two"); }',
      'utf8',
    );
    const second = await scanNextAppRoutes({
      rootDir,
      apiDir: 'src/app/api',
    });

    expect(first.candidates[0]?.sourceFingerprint)
      .not.toBe(second.candidates[0]?.sourceFingerprint);
  });

  it('writes a deterministic local scan artifact for platform sync', async () => {
    const rootDir = await fixture({
      'src/app/api/tasks/route.ts':
        'export async function GET() { return new Response("ok"); }',
    });

    const artifact = await writeNextAppRouteScan({
      rootDir,
      apiDir: 'src/app/api',
      outputPath: '.glirastes/route-scan.json',
    });
    const persisted = JSON.parse(await readFile(artifact.outputPath, 'utf8'));

    expect(persisted).toEqual({
      schemaVersion: 1,
      generatedAt: expect.any(String),
      candidates: artifact.result.candidates,
      ignored: [],
    });
  });
});
