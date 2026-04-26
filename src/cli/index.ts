import {
  generateEndpointRegistry,
  generateUiRegistry,
  generateActionIdRegistry,
  generateModuleRegistry,
  validateAiTools,
  formatValidationReport,
  checkAiCoverage,
  formatCoverageReport,
  scaffoldAiTool,
  formatScaffoldResult,
  generateAgentSkills,
  generateMcpServer,
  recommendOutputFormat,
  syncAssetToGlirastes,
  type GenerateSkillsOptions,
} from '../codegen/index.js';

type CommandName =
  | 'generate'
  | 'validate'
  | 'generate-tools'
  | 'generate-endpoint-tools'
  | 'generate-ui-tools'
  | 'generate-modules'
  | 'generate-skills'
  | 'generate-mcp-server'
  | 'generate-auto'
  | 'validate-tools'
  | 'coverage'
  | 'scaffold'
  | 'test'
  | 'check-upgrade'
  | 'sync';

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseCommand(args: string[]): { command: CommandName; rest: string[] } {
  const [command, ...rest] = args;

  const validCommands: CommandName[] = [
    'generate',
    'validate',
    'generate-tools',
    'generate-endpoint-tools',
    'generate-ui-tools',
    'generate-modules',
    'generate-skills',
    'generate-mcp-server',
    'generate-auto',
    'validate-tools',
    'coverage',
    'scaffold',
    'test',
    'check-upgrade',
    'sync',
  ];

  if (!command || !validCommands.includes(command as CommandName)) {
    throw new Error(
      `Usage: glirastes <command> [options]\n\nCommands:\n` +
        `  generate              Generate endpoint tools from OpenAPI spec\n` +
        `  validate              Validate OpenAPI spec\n` +
        `  generate-tools        Generate all registries (endpoint + UI + modules)\n` +
        `  generate-endpoint-tools  Generate endpoint tool registry\n` +
        `  generate-ui-tools     Generate UI tool registry + action IDs\n` +
        `  generate-modules      Generate module registry\n` +
        `  generate-skills       Generate agent skill files (Claude Code / Codex) [--sync] [--remote]\n` +
        `  generate-mcp-server   Generate MCP server project from tool definitions [--sync] [--remote]\n` +
        `  generate-auto         Auto-detect best output format and generate\n` +
        `  validate-tools        Validate AI tool configuration\n` +
        `  coverage              Check AI tool coverage\n` +
        `  scaffold              Scaffold ai-tool.ts from route.ts\n` +
        `  test                  Scaffold AI behavior test file\n` +
        `  check-upgrade         Analyze upgrade gaps from release notes (--from-version)\n` +
        `  sync                  Sync tool schemas to Glirastes platform\n`,
    );
  }

  return { command: command as CommandName, rest };
}

export async function runCli(args: string[]): Promise<void> {
  const { command, rest } = parseCommand(args);

  // OpenAPI commands — lazy-load openapi-gen to avoid requiring it at startup
  if (command === 'validate') {
    const { validateOpenApiFile } = await import('../openapi/index.js');
    const inputPath = getFlagValue(rest, '--input');
    if (!inputPath) throw new Error('--input is required.');

    const validation = await validateOpenApiFile({ inputPath });
    for (const warning of validation.warnings) console.warn(warning);

    if (validation.errors.length > 0) {
      throw new Error(
        `OpenAPI validation failed:\n${validation.errors.join('\n')}`,
      );
    }

    console.log(
      `OpenAPI valid. Enabled AI tools: ${validation.enabledTools}. Warnings: ${validation.warnings.length}.`,
    );
    return;
  }

  if (command === 'generate') {
    const { generateFromOpenApiFile } = await import('../openapi/index.js');
    const inputPath = getFlagValue(rest, '--input');
    const outputPath = getFlagValue(rest, '--output');
    if (!inputPath) throw new Error('--input is required.');
    if (!outputPath) throw new Error('--output is required for generate.');

    const validation = await generateFromOpenApiFile({ inputPath, outputPath });
    for (const warning of validation.warnings) console.warn(warning);

    console.log(`Generated endpoint tools at ${outputPath}`);
    console.log(
      `Enabled AI tools: ${validation.enabledTools}. Warnings: ${validation.warnings.length}.`,
    );
    return;
  }

  // Project-based commands — need rootDir
  const rootDir = getFlagValue(rest, '--root') ?? process.cwd();
  const quiet = hasFlag(rest, '--quiet');
  const ci = hasFlag(rest, '--ci');

  // Read glirastes config from package.json (supports monorepo scan/output config)
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const pkgJsonPath = join(rootDir, 'package.json');
  let glirastesConfig: { scan?: string[]; output?: string; nestjsApiPrefix?: string; apiDir?: string; componentsDir?: string } = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    glirastesConfig = (pkg.glirastes ?? {}) as typeof glirastesConfig;
  } catch {
    // No package.json or no glirastes field — use defaults
  }

  // Derive nestjsDirs from scan config: dirs that contain NestJS controllers
  const nestjsDirs = (glirastesConfig.scan ?? [])
    .map(d => join(rootDir, d))
    .filter(d => existsSync(d));

  const options = {
    rootDir,
    quiet,
    outputDir: glirastesConfig.output,
    apiDir: glirastesConfig.apiDir,
    componentsDir: glirastesConfig.componentsDir,
    nestjsDirs: nestjsDirs.length > 0 ? nestjsDirs : undefined,
    nestjsApiPrefix: glirastesConfig.nestjsApiPrefix,
  };

  if (command === 'generate-tools') {
    const metaPath = getFlagValue(rest, '--meta');

    const generateOpts = options;

    await generateEndpointRegistry(generateOpts);
    await generateUiRegistry(generateOpts);
    await generateActionIdRegistry(generateOpts);

    // Only generate modules if there are tools with module metadata
    try {
      await generateModuleRegistry(generateOpts, metaPath);
    } catch {
      if (!quiet) console.log('\u2139 Module generation skipped (no module metadata found)');
    }

    // Run coverage and validation
    const report = await checkAiCoverage(generateOpts);
    console.log(formatCoverageReport(report, { quiet }));

    const validation = await validateAiTools(generateOpts);
    if (validation.issues.length > 0) {
      console.log(formatValidationReport(validation, { quiet }));
    }

    if (ci && !validation.passed) {
      process.exit(1);
    }
    return;
  }

  if (command === 'generate-endpoint-tools') {
    await generateEndpointRegistry(options);
    return;
  }

  if (command === 'generate-ui-tools') {
    await generateUiRegistry(options);
    await generateActionIdRegistry(options);
    return;
  }

  if (command === 'generate-modules') {
    const metaPath = getFlagValue(rest, '--meta');
    await generateModuleRegistry(options, metaPath);
    return;
  }

  if (command === 'generate-skills') {
    const appName = getFlagValue(rest, '--app-name');
    const baseUrl = getFlagValue(rest, '--base-url');
    const authType = getFlagValue(rest, '--auth') ?? 'bearer';
    const tokenEnvVar = getFlagValue(rest, '--token-env') ?? 'API_TOKEN';
    const format = getFlagValue(rest, '--format'); // markdown, json, or both (default)
    const outputDir = getFlagValue(rest, '--output-dir');

    if (!appName) throw new Error('--app-name is required for generate-skills.');
    if (!baseUrl) throw new Error('--base-url is required for generate-skills.');

    const authStrategy = buildAuthStrategy(authType, tokenEnvVar, rest);
    const formats: Array<'markdown' | 'json'> =
      format === 'markdown' ? ['markdown'] :
      format === 'json' ? ['json'] :
      ['markdown', 'json'];

    const skillConfig = { appName, baseUrl, auth: authStrategy };
    const result = await generateAgentSkills({
      ...options,
      skillConfig,
      formats,
      skillOutputDir: outputDir,
    });

    const remote = hasFlag(rest, '--remote');
    const shouldSync = rest.includes('--sync') || remote;
    if (shouldSync) {
      const apiKey = getFlagValue(rest, '--glirastes-key') ?? process.env.GLIRASTES_API_KEY;
      const glirasterUrl = getFlagValue(rest, '--glirastes-url') ?? process.env.GLIRASTES_URL ?? 'https://api.glirastes.chainmatics.io';
      if (!apiKey) {
        console.warn('⚠ --sync/--remote requires GLIRASTES_API_KEY or --glirastes-key');
      } else {
        const syncResult = await syncAssetToGlirastes({
          apiKey,
          glirasterUrl,
          name: appName,
          type: 'skill',
          version: '1.0.0',
          toolCount: result.toolCount,
          config: { appName, baseUrl, auth: authStrategy },
          toolManifest: { tools: result.tools },
        });
        console.log(`✓ Synced to Glirastes: skill "${appName}" (${syncResult.action})`);

        if (remote) {
          const generateRes = await fetch(`${glirasterUrl}/v1/registry/assets/${syncResult.assetId}/generate`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          });

          if (!generateRes.ok) {
            console.warn(`⚠ Remote generation failed (${generateRes.status})`);
          } else {
            const genResult = await generateRes.json() as { version: string; files: unknown[] };
            console.log(`✓ Remote generation complete: v${genResult.version}, ${genResult.files.length} files`);
          }
        }
      }
    }

    if (remote) {
      console.log(`✓ Remote generation triggered for skill "${appName}"`);
      return;
    }

    return;
  }

  if (command === 'generate-mcp-server') {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');

    const appName = getFlagValue(rest, '--app-name');
    const baseUrl = getFlagValue(rest, '--base-url');
    const authType = getFlagValue(rest, '--auth') ?? 'bearer';
    const tokenEnvVar = getFlagValue(rest, '--token-env') ?? 'API_TOKEN';
    const outputDir = getFlagValue(rest, '--output-dir') ?? 'mcp-server';

    if (!appName) throw new Error('--app-name is required for generate-mcp-server.');
    if (!baseUrl) throw new Error('--base-url is required for generate-mcp-server.');

    const authStrategy = buildAuthStrategy(authType, tokenEnvVar, rest);

    const result = await generateMcpServer({
      ...options,
      skillConfig: { appName, baseUrl, auth: authStrategy },
      mcpOutputDir: outputDir,
    });

    const remote = hasFlag(rest, '--remote');

    // Write generated files to disk (skip when --remote)
    if (!remote) {
      for (const file of result.files) {
        const fullPath = join(rootDir, file.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content, 'utf-8');
        if (!quiet) console.log(`  wrote ${file.path}`);
      }

      if (!quiet) {
        console.log(`\nMCP server generated: ${result.toolCount} tools across ${result.modulesUsed.length} modules`);
      }
    }

    const shouldSync = rest.includes('--sync') || remote;
    if (shouldSync) {
      const apiKey = getFlagValue(rest, '--glirastes-key') ?? process.env.GLIRASTES_API_KEY;
      const glirasterUrl = getFlagValue(rest, '--glirastes-url') ?? process.env.GLIRASTES_URL ?? 'https://api.glirastes.chainmatics.io';
      if (!apiKey) {
        console.warn('⚠ --sync/--remote requires GLIRASTES_API_KEY or --glirastes-key');
      } else {
        const syncResult = await syncAssetToGlirastes({
          apiKey,
          glirasterUrl,
          name: appName,
          type: 'mcp-server',
          version: '1.0.0',
          toolCount: result.toolCount,
          config: { appName, baseUrl, auth: authStrategy },
          toolManifest: { tools: result.tools, modules: result.modulesUsed },
        });
        console.log(`✓ Synced to Glirastes: mcp-server "${appName}" (${syncResult.action})`);

        if (remote) {
          const generateRes = await fetch(`${glirasterUrl}/v1/registry/assets/${syncResult.assetId}/generate`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          });

          if (!generateRes.ok) {
            console.warn(`⚠ Remote generation failed (${generateRes.status})`);
          } else {
            const genResult = await generateRes.json() as { version: string; files: unknown[] };
            console.log(`✓ Remote generation complete: v${genResult.version}, ${genResult.files.length} files`);
          }
        }
      }
    }

    if (remote) {
      console.log(`✓ Remote generation triggered for mcp-server "${appName}"`);
    }

    return;
  }

  if (command === 'generate-auto') {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');

    const appName = getFlagValue(rest, '--app-name');
    const baseUrl = getFlagValue(rest, '--base-url');
    const authType = getFlagValue(rest, '--auth') ?? 'bearer';
    const tokenEnvVar = getFlagValue(rest, '--token-env') ?? 'API_TOKEN';
    const skillOutputDir = getFlagValue(rest, '--skill-output-dir');
    const mcpOutputDir = getFlagValue(rest, '--mcp-output-dir') ?? 'mcp-server';

    if (!appName) throw new Error('--app-name is required for generate-auto.');
    if (!baseUrl) throw new Error('--base-url is required for generate-auto.');

    const authStrategy = buildAuthStrategy(authType, tokenEnvVar, rest);

    const hasStreaming = hasFlag(rest, '--streaming');
    const hasWebSocket = hasFlag(rest, '--websocket');
    const multiAgentAccess = hasFlag(rest, '--multi-agent');
    const toolCountStr = getFlagValue(rest, '--tool-count');
    const toolCount = toolCountStr ? parseInt(toolCountStr, 10) : undefined;

    const recommendation = recommendOutputFormat({
      auth: authStrategy,
      hasStreaming,
      hasWebSocket,
      multiAgentAccess,
      toolCount,
    });

    if (!quiet) {
      console.log(`Auto-detected format: ${recommendation.format}`);
      console.log(`  Reason: ${recommendation.reason}`);
      console.log('');
    }

    const skillConfig = { appName, baseUrl, auth: authStrategy };

    if (recommendation.format === 'skill' || recommendation.format === 'both') {
      await generateAgentSkills({
        ...options,
        skillConfig,
        formats: ['markdown', 'json'],
        skillOutputDir,
      });
    }

    if (recommendation.format === 'mcp' || recommendation.format === 'both') {
      const result = await generateMcpServer({
        ...options,
        skillConfig,
        mcpOutputDir,
      });

      // Write generated MCP files to disk
      for (const file of result.files) {
        const fullPath = join(rootDir, file.path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, file.content, 'utf-8');
        if (!quiet) console.log(`  wrote ${file.path}`);
      }
    }

    return;
  }

  if (command === 'validate-tools') {
    const showFix = hasFlag(rest, '--fix');
    const validation = await validateAiTools(options);
    console.log(formatValidationReport(validation, { quiet, showFix }));

    if (ci && !validation.passed) {
      process.exit(1);
    }
    return;
  }

  if (command === 'coverage') {
    const report = await checkAiCoverage(options);
    console.log(formatCoverageReport(report, { quiet }));

    if (ci) {
      const hasIssues = report.routeCoveragePercent < 100 ||
        report.componentCoveragePercent < 100 ||
        report.missingHandlers.length > 0;
      if (hasIssues) process.exit(1);
    }
    return;
  }

  if (command === 'scaffold') {
    const routeFile = getFlagValue(rest, '--route');
    if (!routeFile) throw new Error('--route is required for scaffold.');

    const force = hasFlag(rest, '--force');
    const dryRun = hasFlag(rest, '--dry-run');

    const result = await scaffoldAiTool({
      routeFile,
      rootDir,
      force,
      dryRun,
    });

    console.log(formatScaffoldResult(result, { dryRun, rootDir }));
    return;
  }

  if (command === 'test') {
    const { scaffoldTestFile } = await import('./commands/test.js');
    const outputPath = getFlagValue(rest, '--output');
    const force = hasFlag(rest, '--force');
    const dryRun = hasFlag(rest, '--dry-run');

    await scaffoldTestFile({ rootDir, outputPath, force, dryRun });
    return;
  }

  if (command === 'check-upgrade') {
    const { checkUpgrade } = await import('./commands/check-upgrade.js');
    const fromVersion = getFlagValue(rest, '--from-version');
    await checkUpgrade({ rootDir, fromVersion });
    return;
  }

  // Sync tool schemas to Glirastes platform
  if (command === 'sync') {
    const apiKey = getFlagValue(rest, '--api-key') ?? process.env.GLIRASTES_API_KEY ?? process.env.CHAINMATICS_API_KEY;
    const baseUrl = getFlagValue(rest, '--url') ?? process.env.GLIRASTES_URL ?? 'https://api.glirastes.chainmatics.io';

    if (!apiKey) {
      throw new Error(
        'API key required. Use --api-key or set GLIRASTES_API_KEY env var.',
      );
    }

    const { scanEndpointTools, scanUiTools } = await import('../codegen/index.js');
    const { readFile } = await import('fs/promises');

    // Collect all tools (endpoint + UI)
    const tools: Array<{ toolId: string; version: string; type: string; schema: object; moduleId?: string; metadata: object }> = [];

    // --- Endpoint tools ---
    const scanResult = await scanEndpointTools(options);
    for (const file of scanResult.files) {
      const content = await readFile(file.absolutePath, 'utf-8');
      // Match defineEndpointTool({ id: '...' }) or defineAiEndpointTool({ id: '...' })
      const idMatches = content.matchAll(/define(?:Ai)?EndpointTool\(\s*\{[^}]*?id:\s*['"]([^'"]+)['"]/gs);
      for (const match of idMatches) {
        const toolId = match[1];
        // Try to extract description
        const descMatch = content.match(new RegExp(`id:\\s*['"]${toolId}['"][^}]*?description:\\s*['"]([^'"]+)['"]`, 's'));
        // Try to extract allowedRoles array
        const allowedRoles = extractAllowedRoles(content);
        // Try to extract module
        const moduleMatch = content.match(/module:\s*['"]([^'"]+)['"]/);
        tools.push({
          toolId,
          version: '1.0.0',
          type: 'endpoint',
          schema: {},
          moduleId: moduleMatch?.[1] ?? undefined,
          metadata: {
            description: descMatch?.[1] ?? '',
            sourceFile: file.relativePath,
            allowedRoles,
          },
        });
      }
      // Also match single tool: defineEndpointTool({ ... }) with withAiTool pattern
      if (tools.length === 0 && file.exportType === 'single') {
        const singleId = content.match(/id:\s*['"]([^'"]+)['"]/);
        if (singleId) {
          const allowedRoles = extractAllowedRoles(content);
          const moduleMatch = content.match(/module:\s*['"]([^'"]+)['"]/);
          tools.push({
            toolId: singleId[1],
            version: '1.0.0',
            type: 'endpoint',
            schema: {},
            moduleId: moduleMatch?.[1] ?? undefined,
            metadata: {
              sourceFile: file.relativePath,
              allowedRoles,
            },
          });
        }
      }
    }

    // --- UI tools ---
    const uiScanResult = await scanUiTools(options);
    for (const file of uiScanResult.files) {
      const content = await readFile(file.absolutePath, 'utf-8');
      // Extract each toolName from defineUiTool / defineAiUiTool blocks
      const toolNameMatches = content.matchAll(/toolName\s*:\s*['"]([^'"]+)['"]/g);
      for (const match of toolNameMatches) {
        const toolName = match[1];
        const descMatch = content.match(/description\s*:\s*`([^`]+)`/s) ??
                          content.match(/description\s*:\s*['"]([^'"]+)['"]/);
        const allowedRoles = extractAllowedRoles(content);
        const moduleMatch = content.match(/module:\s*['"]([^'"]+)['"]/);
        tools.push({
          toolId: toolName,
          version: '1.0.0',
          type: 'ui',
          schema: {},
          moduleId: moduleMatch?.[1] ?? undefined,
          metadata: {
            description: descMatch?.[1]?.trim().slice(0, 200) ?? '',
            sourceFile: file.relativePath,
            allowedRoles,
          },
        });
      }
    }

    // --- NestJS @AiTool decorated controllers ---
    if (options.nestjsDirs && options.nestjsDirs.length > 0) {
      const { scanNestControllers } = await import('../codegen/index.js');
      const nestResult = await scanNestControllers(options.nestjsDirs, options.nestjsApiPrefix ?? '/api');
      for (const tool of nestResult.tools) {
        tools.push({
          toolId: tool.name,
          version: '1.0.0',
          type: 'endpoint',
          schema: {},
          moduleId: tool.module ?? undefined,
          metadata: {
            description: tool.description?.slice(0, 200) ?? '',
            sourceFile: tool.controllerFile,
            allowedRoles: tool.allowedRoles ?? [],
            ...(tool.needsApproval ? { needsApproval: true } : {}),
          },
        });
      }
    }

    if (tools.length === 0) {
      console.log('No tools found. Run "glirastes generate-tools" first.');
      return;
    }

    const endpointCount = tools.filter(t => t.type === 'endpoint').length;
    const uiCount = tools.filter(t => t.type === 'ui').length;
    // POST to Glirastes Registry
    console.log(`Syncing ${tools.length} tools (${endpointCount} endpoint, ${uiCount} UI) to ${baseUrl}...`);
    const response = await fetch(`${baseUrl}/v1/registry/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ tools }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sync failed (${response.status}): ${body}`);
    }

    const result = await response.json() as { added: string[]; updated: string[]; unchanged: string[] };
    console.log(`Synced ${tools.length} tools to Glirastes:`);
    if (result.added.length > 0) console.log(`  Added: ${result.added.join(', ')}`);
    if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(', ')}`);
    if (result.unchanged.length > 0) console.log(`  Unchanged: ${result.unchanged.length} tools`);

    // Sync module prompts as baseline overrides (optional --meta flag)
    const metaPath = getFlagValue(rest, '--meta');
    if (metaPath) {
      const { readFile } = await import('fs/promises');
      const { resolve } = await import('path');
      const metaFile = resolve(rootDir, metaPath);
      try {
        const metaContent = await readFile(metaFile, 'utf-8');
        // Extract systemPrompt per module from metadata file
        const modulePrompts: Array<{ moduleId: string; systemPrompt: string }> = [];
        // Match patterns like: moduleId: { ... systemPrompt: `...` }
        const moduleBlocks = metaContent.matchAll(/(\w+)\s*:\s*\{[^}]*systemPrompt\s*:\s*`([^`]+)`/gs);
        for (const match of moduleBlocks) {
          modulePrompts.push({
            moduleId: match[1],
            systemPrompt: match[2].trim(),
          });
        }

        if (modulePrompts.length > 0) {
          console.log(`\nSyncing ${modulePrompts.length} module prompt baselines...`);
          for (const mp of modulePrompts) {
            const promptRes = await fetch(`${baseUrl}/v1/primus/modules/${encodeURIComponent(mp.moduleId)}/prompt`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                mode: 'replace',
                systemPrompt: mp.systemPrompt,
              }),
            });
            if (promptRes.ok) {
              console.log(`  Synced prompt for module: ${mp.moduleId}`);
            } else {
              console.warn(`  Failed to sync prompt for module: ${mp.moduleId} (${promptRes.status})`);
            }
          }
        }
      } catch {
        // Meta file not found or unreadable — skip prompt sync silently
      }
    }
    return;
  }
}

/**
 * Extract allowedRoles array from tool source file content.
 * Matches patterns like: allowedRoles: ['admin', 'manager']
 */
function extractAllowedRoles(content: string): string[] {
  const match = content.match(/allowedRoles:\s*\[([^\]]*)\]/);
  if (!match) return [];
  const inner = match[1];
  const roles: string[] = [];
  const roleMatches = inner.matchAll(/['"]([^'"]+)['"]/g);
  for (const m of roleMatches) {
    roles.push(m[1]);
  }
  return roles;
}

function buildAuthStrategy(
  authType: string,
  tokenEnvVar: string,
  args: string[],
): GenerateSkillsOptions['skillConfig']['auth'] {
  switch (authType) {
    case 'api-key':
      return {
        type: 'api-key',
        headerName: getFlagValue(args, '--header-name') ?? 'X-API-Key',
        keyEnvVar: tokenEnvVar,
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        tokenUrl: getFlagValue(args, '--token-url') ?? '',
        clientIdEnvVar: getFlagValue(args, '--client-id-env') ?? 'OAUTH_CLIENT_ID',
        clientSecretEnvVar: getFlagValue(args, '--client-secret-env') ?? 'OAUTH_CLIENT_SECRET',
        scopes: getFlagValue(args, '--scopes')?.split(','),
      };
    case 'cookie':
      return { type: 'cookie' };
    case 'bearer':
    default:
      return { type: 'bearer', tokenEnvVar };
  }
}
