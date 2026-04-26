import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Recursively find all files matching a given name in a directory.
 */
export async function findFiles(
  dir: string,
  fileName: string,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // Directory doesn't exist or is inaccessible
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(fullPath);
      } else if (entry.name === fileName) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

/**
 * Check if a file contains the @ai-ignore marker.
 */
export async function hasAiIgnore(filePath: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.includes('@ai-ignore');
  } catch {
    return false;
  }
}

/**
 * Check if a directory should be ignored for AI tool coverage.
 * Checks for @ai-ignore in index.ts/index.tsx or .ai-ignore marker file.
 */
export async function isDirAiIgnored(dirPath: string): Promise<boolean> {
  // Check for .ai-ignore marker file
  try {
    await stat(join(dirPath, '.ai-ignore'));
    return true;
  } catch {
    // Not found, continue
  }

  // Check for @ai-ignore in index.ts or index.tsx
  for (const indexFile of ['index.ts', 'index.tsx']) {
    const indexPath = join(dirPath, indexFile);
    if (await hasAiIgnore(indexPath)) return true;
  }

  return false;
}

/**
 * Convert an absolute file path to a module import path.
 * e.g., /project/src/app/api/tasks/ai-tool.ts → @/app/api/tasks/ai-tool
 */
export function toImportPath(
  absolutePath: string,
  rootDir: string,
  srcPrefix: string = 'src',
  alias: string = '@',
): string {
  const rel = relative(rootDir, absolutePath);
  // Remove src/ prefix and .ts extension
  const withoutSrc = rel.startsWith(srcPrefix + sep)
    ? rel.slice(srcPrefix.length + 1)
    : rel;
  const withoutExt = withoutSrc.replace(/\.tsx?$/, '');
  return `${alias}/${withoutExt.split(sep).join('/')}`;
}

/**
 * Convert an absolute file path to a relative import path from a given output directory.
 * Used when source and output are in different parts of a monorepo where @/ aliases don't work.
 */
export function toRelativeImportPath(
  absolutePath: string,
  outputDir: string,
): string {
  const rel = relative(outputDir, absolutePath);
  const withoutExt = rel.replace(/\.tsx?$/, '');
  const normalized = withoutExt.split(sep).join('/');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

/**
 * Read file contents, returns empty string if file doesn't exist.
 */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Find all route.ts files in a directory.
 */
export async function findRouteFiles(dir: string): Promise<string[]> {
  return findFiles(dir, 'route.ts');
}

/**
 * Extract all top-level brace-balanced blocks for a given function call.
 * Handles nested braces correctly (e.g., z.object({...}), uiAction: { payload: {...} }).
 *
 * @param content    Source file content
 * @param fnPattern  Regex that matches the function call prefix up to (but not including) the opening `{`.
 *                   Must NOT have the `g` flag — it is added internally.
 * @returns Array of the inner content of each matched block (between the outermost `{` and `}`).
 */
export function extractBalancedBlocks(
  content: string,
  fnPattern: RegExp,
): string[] {
  const results: string[] = [];
  const globalPattern = new RegExp(fnPattern.source, 'g');

  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = globalPattern.exec(content)) !== null) {
    // Find the opening { after the function call prefix
    const searchStart = prefixMatch.index + prefixMatch[0].length;
    const braceStart = content.indexOf('{', searchStart);
    if (braceStart === -1) continue;

    // Walk forward counting braces
    let depth = 0;
    let i = braceStart;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      if (depth === 0) break;
    }

    if (depth === 0) {
      // Extract inner content (between outermost braces)
      results.push(content.slice(braceStart + 1, i));
    }
  }

  return results;
}

/**
 * Get all immediate subdirectories of a directory.
 */
export async function getSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}
