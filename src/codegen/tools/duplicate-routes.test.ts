import { afterEach, describe, expect, it } from 'vitest';
import { createAppFixture, removeAppFixtures } from './__tests__/app-fixture.js';
import { TOOLS_PATHS } from './config.js';
import { runToolsPipeline, ToolsPipelineFailure } from './pipeline.js';

afterEach(removeAppFixtures);

const GUARD = "import { Injectable, type CanActivate } from '@nestjs/common';\n"
  + '@Injectable()\nexport class SessionGuard implements CanActivate {\n  canActivate() { return true; }\n}\n';
const usageController = (name: string) => "import { Controller, Get, UseGuards } from '@nestjs/common';\n"
  + "import { SessionGuard } from './session.guard.js';\n"
  + `@Controller('v1/tenant')\n@UseGuards(SessionGuard)\nexport class ${name} {\n`
  + "  @Get('usage')\n  usage() {\n    return { used: 1 };\n  }\n}\n";
const OTHER = "import { Controller, Get, UseGuards } from '@nestjs/common';\n"
  + "import { SessionGuard } from './session.guard.js';\n"
  + "@Controller('v1/other')\n@UseGuards(SessionGuard)\nexport class OtherController {\n"
  + "  @Get('ping')\n  ping() {\n    return { ok: true };\n  }\n}\n";

async function fixture() {
  return createAppFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true, types: [] } }),
    'src/session.guard.ts': GUARD,
    'src/usage-a.controller.ts': usageController('UsageAController'),
    'src/usage-b.controller.ts': usageController('UsageBController'),
    'src/other.controller.ts': OTHER,
  }, { toolsConfig: { sources: [{ kind: 'nest' }] } });
}

describe('a route declared by two controllers', () => {
  it('does not stop the refresh: the other tool is generated and the route has no enabled tool', async () => {
    const app = await fixture();
    const outcome = await runToolsPipeline({ root: app.root, mode: 'write' }).then(() => undefined, (error: unknown) => error);

    // Same exit behaviour as every error finding: the pipeline fails unless --keep-going.
    expect(outcome).toBeInstanceOf(ToolsPipelineFailure);
    const result = (outcome as ToolsPipelineFailure).result;
    expect(result.wrote).toBe(true);
    const finding = result.findings.filter((entry) => entry.code === 'route-declared-twice');
    expect(finding).toHaveLength(1);
    expect(finding[0]).toMatchObject({ severity: 'error', subjectRef: 'GET /v1/tenant/usage' });
    expect(finding[0]!.message).toContain('src/usage-a.controller.ts');
    expect(finding[0]!.message).toContain('src/usage-b.controller.ts');
    const byKey = new Map((result.tools ?? []).map((tool) => [tool.stableKey, tool] as const));
    expect(byKey.get('GET /v1/other/ping')?.enabled).toBe(true);
    expect(byKey.get('GET /v1/tenant/usage')).toMatchObject({ enabled: false, contract: null });
    expect(await app.read(TOOLS_PATHS.inventory)).toContain('GET /v1/other/ping');
  });

  it('returns the result under keepGoing and still writes', async () => {
    const app = await fixture();
    const result = await runToolsPipeline({ root: app.root, mode: 'write', keepGoing: true });

    expect(result.wrote).toBe(true);
    expect(result.findings.some((entry) => entry.code === 'route-declared-twice')).toBe(true);
    expect((result.tools ?? []).find((tool) => tool.stableKey === 'GET /v1/other/ping')?.enabled).toBe(true);
  });

  it('reports a route declared three times once, naming all three files', async () => {
    const app = await fixture();
    await app.write('src/usage-c.controller.ts', usageController('UsageCController'));
    const result = await runToolsPipeline({ root: app.root, mode: 'write', keepGoing: true });

    const finding = result.findings.filter((entry) => entry.code === 'route-declared-twice');
    expect(finding).toHaveLength(1);
    for (const letter of ['a', 'b', 'c']) expect(finding[0]!.message).toContain(`src/usage-${letter}.controller.ts`);
  });

  it('is silent once the route is excluded by policy', async () => {
    const app = await fixture();
    await app.write('.glirastes/tool-policy.json', `${JSON.stringify({
      schemaVersion: 1, tools: {}, acceptedRisk: {}, exclude: [{ match: 'GET /v1/tenant/usage', reason: 'internal' }],
    })}\n`);
    const result = await runToolsPipeline({ root: app.root, mode: 'write' });

    expect(result.findings.some((entry) => entry.code === 'route-declared-twice')).toBe(false);
    expect((result.tools ?? []).map((tool) => tool.stableKey)).toEqual(['GET /v1/other/ping']);
  });
});
