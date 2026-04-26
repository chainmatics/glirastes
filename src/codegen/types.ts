/**
 * Configuration for code generation.
 */
export interface GenerateOptions {
  /** Root directory of the project (where src/ lives) */
  rootDir: string;
  /** Directory pattern for API routes (e.g., 'src/app/api') */
  apiDir?: string;
  /** Directory pattern for components (e.g., 'src/components') */
  componentsDir?: string;
  /** Output directory for generated files (e.g., 'src/generated/ai-tools') */
  outputDir?: string;
  /** File name for endpoint tool definitions (default: 'ai-tool.ts') */
  endpointToolFileName?: string;
  /** File name for UI tool definitions (default: 'ai-ui-tool.ts') */
  uiToolFileName?: string;
  /** Directories to scan for NestJS controllers with @AiTool decorators */
  nestjsDirs?: string[];
  /** API prefix for NestJS routes (default: '/api') */
  nestjsApiPrefix?: string;
  /** Quiet mode — suppress informational output */
  quiet?: boolean;
}

export interface ScanResult {
  /** Discovered files with their relative paths */
  files: DiscoveredFile[];
  /** Total number of tools found */
  toolCount: number;
}

export interface DiscoveredFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to rootDir */
  relativePath: string;
  /** Import path (e.g., '@/app/api/tasks/ai-tool') */
  importPath: string;
  /** Whether the file exports an array (aiTools) or single (aiTool) */
  exportType: 'array' | 'single';
}

export interface ExtractedActionId {
  actionId: string;
  toolName: string;
  payloadKeys: string[];
  sourceFile: string;
}

export interface ExtractedToolMeta {
  toolName: string;
  module?: string;
  sharedWith?: string[];
  sourceFile: string;
}

export function resolveDefaults(options: GenerateOptions): Required<GenerateOptions> {
  return {
    rootDir: options.rootDir,
    apiDir: options.apiDir ?? 'src/app/api',
    componentsDir: options.componentsDir ?? 'src/components',
    outputDir: options.outputDir ?? 'src/generated/ai-tools',
    endpointToolFileName: options.endpointToolFileName ?? 'ai-tool.ts',
    uiToolFileName: options.uiToolFileName ?? 'ai-ui-tool.ts',
    nestjsDirs: options.nestjsDirs ?? [],
    nestjsApiPrefix: options.nestjsApiPrefix ?? '/api',
    quiet: options.quiet ?? false,
  };
}
