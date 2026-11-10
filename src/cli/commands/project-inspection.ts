import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';

const LIMITS = { depth: 4, directories: 128, entriesPerDirectory: 2_048, manifestBytes: 262_144 } as const;
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml']);
const IGNORED = new Set(['node_modules', 'vendor', 'dist', 'build', 'generated', 'coverage', 'venv', '__pycache__']);
const PackageManifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

const NODE_MARKERS = [
  ['next', 'frontend', 'nextjs'], ['next', 'backend', 'nextjs'],
  ['react', 'frontend', 'react'], ['vue', 'frontend', 'vue'],
  ['@nestjs/core', 'backend', 'nestjs'],
  ['@clerk/nextjs', 'auth', 'clerk'], ['@azure/msal-node', 'auth', 'entra'],
] as const;

export interface InspectedProjectComponent {
  directory: string;
  /** Manifest hints, not verified installed runtimes or deployment topology. */
  runtimes: Array<'node' | 'python'>;
  frontend: Array<'nextjs' | 'react' | 'vue'>;
  backend: Array<'nextjs' | 'nestjs' | 'fastapi'>;
  auth: Array<'clerk' | 'entra'>;
  evidence: Array<{ file: string; marker: string }>;
}

type FindingCode = 'linked-path-skipped' | 'invalid-manifest' | 'manifest-too-large'
  | 'manifest-not-readable' | 'directory-not-readable' | 'inspection-depth-limit'
  | 'inspection-directory-limit' | 'inspection-entry-limit' | 'requirements-indirection';

/** Local agent intake only. Never upload this as a Platform setup artifact. */
export interface SetupProjectInspection {
  schemaVersion: 1;
  scope: 'local-only';
  status: 'needs-integration-verification';
  components: InspectedProjectComponent[];
  findings: Array<{ code: FindingCode; file: string }>;
  limits: typeof LIMITS;
}

/** Reads declarations, never imports source, executes scripts or loads credentials. */
export async function inspectSetupProject(rootDir: string): Promise<SetupProjectInspection> {
  const invalidRoot = () => new FoundationDiagnosticError({
    code: 'E-SETUP-007', operation: 'setup.inspect',
    message: 'The project folder cannot be inspected.',
    remediation: 'repair-local-project-profile',
  });
  let root: string;
  try { root = await realpath(resolve(rootDir)); }
  catch { throw invalidRoot(); }
  const report: SetupProjectInspection = {
    schemaVersion: 1, scope: 'local-only', status: 'needs-integration-verification',
    components: [], findings: [], limits: LIMITS,
  };
  const finding = (code: FindingCode, file: string) => { report.findings.push({ code, file }); };
  const queue = [{ directory: '', depth: 0 }];
  let directories = 0;

  while (queue.length > 0) {
    const { directory, depth } = queue.shift()!;
    if (++directories > LIMITS.directories) {
      finding('inspection-directory-limit', directory || '.');
      break;
    }
    let handle;
    try {
      const absolute = join(root, directory);
      if (await realpath(absolute) !== absolute) {
        finding('linked-path-skipped', directory || '.');
        continue;
      }
      handle = await opendir(absolute);
      if (await realpath(absolute) !== absolute) {
        await handle.close();
        handle = undefined;
        finding('linked-path-skipped', directory || '.');
        continue;
      }
    } catch {
      await handle?.close();
      if (directory === '') throw invalidRoot();
      finding('directory-not-readable', directory);
      continue;
    }
    const entries = [];
    for await (const entry of handle) {
      if (entries.length === LIMITS.entriesPerDirectory) {
        finding('inspection-entry-limit', directory || '.');
        break;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const component: InspectedProjectComponent = {
      directory: directory || '.', runtimes: [], frontend: [], backend: [], auth: [], evidence: [],
    };
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const file = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        finding('linked-path-skipped', file);
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= LIMITS.depth) finding('inspection-depth-limit', file);
        else queue.push({ directory: file, depth: depth + 1 });
        continue;
      }
      if (!MANIFESTS.has(entry.name)) continue;
      let manifest;
      try {
        const absolute = join(root, file);
        if (await realpath(absolute) !== absolute) { finding('linked-path-skipped', file); continue; }
        manifest = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await manifest.stat();
        if (await realpath(absolute) !== absolute) { finding('linked-path-skipped', file); continue; }
        if (!info.isFile()) { finding('manifest-not-readable', file); continue; }
        if (info.size > LIMITS.manifestBytes) { finding('manifest-too-large', file); continue; }
        if (entry.name === 'pyproject.toml') {
          if (!component.runtimes.includes('python')) component.runtimes.push('python');
          component.evidence.push({ file, marker: 'python-project-file' });
          continue;
        }
        // The extra byte detects growth between stat and read without unbounded reads.
        const buffer = Buffer.alloc(LIMITS.manifestBytes + 1);
        const { bytesRead } = await manifest.read(buffer, 0, buffer.length, 0);
        if (await realpath(absolute) !== absolute) { finding('linked-path-skipped', file); continue; }
        if (bytesRead > LIMITS.manifestBytes) { finding('manifest-too-large', file); continue; }
        const source = buffer.toString('utf8', 0, bytesRead);
        if (entry.name === 'package.json') {
          let parsed;
          try { parsed = PackageManifest.parse(JSON.parse(source)); }
          catch { finding('invalid-manifest', file); continue; }
          component.runtimes.push('node');
          component.evidence.push({ file, marker: 'node-package-file' });
          const declared = { ...parsed.dependencies, ...parsed.devDependencies };
          for (const [dependency, area, technology] of NODE_MARKERS) {
            if (!Object.hasOwn(declared, dependency)) continue;
            // The table keeps each group restricted to its declared literal values.
            (component[area] as string[]).push(technology);
            if (!component.evidence.some((item) => item.file === file && item.marker === dependency)) {
              component.evidence.push({ file, marker: dependency });
            }
          }
        } else {
          if (!component.runtimes.includes('python')) component.runtimes.push('python');
          component.evidence.push({ file, marker: 'python-requirements-file' });
          if (/^\s*fastapi(?=\[|[<>=!~;\s]|$)/im.test(source)) {
            component.backend.push('fastapi');
            component.evidence.push({ file, marker: 'fastapi' });
          }
          if (/^\s*(?:-r\b|--requirement\b|-e\b|--editable\b)/m.test(source)) {
            finding('requirements-indirection', file);
          }
        }
      } catch (error) {
        finding((error as NodeJS.ErrnoException).code === 'ELOOP' ? 'linked-path-skipped' : 'manifest-not-readable', file);
      } finally {
        await manifest?.close();
      }
    }
    if (component.runtimes.length > 0) report.components.push(component);
  }
  return report;
}

export function formatSetupProjectInspection(report: SetupProjectInspection): string {
  const lines = ['Glirastes — project inspection'];
  const technologies = [...new Set(report.components.flatMap((item) => [
    ...item.frontend, ...item.backend, ...item.auth,
  ]))];
  lines.push(technologies.length > 0
    ? `Declared technologies: ${technologies.join(', ')}.`
    : 'No supported manifest markers detected; your coding agent must inspect the stack.');
  lines.push(`${report.components.length} project ${report.components.length === 1 ? 'component' : 'components'} found.`);
  if (report.findings.length > 0) lines.push('Some paths need review or were skipped; details are available with --json.');
  lines.push('This local manifest check does not prove integration, authorization or a successful tool action.');
  lines.push('Next: Have your coding agent inspect the app code and connect its existing UI, backend and server-side permissions.');
  lines.push('Use glirastes setup inspect --json for local evidence and inspection limits.');
  return lines.join('\n');
}
