import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFileSafe, extractBalancedBlocks } from './fs-utils.js';
import { scanEndpointTools } from './endpoint-scanner.js';
import { scanUiTools } from './ui-scanner.js';
import type { GenerateOptions } from './types.js';
import { resolveDefaults } from './types.js';
import type {
  AgentSkillConfig,
  AgentSkillTool,
  AgentAuthStrategy,
  EndpointMethod,
} from '../types.js';

// ============================================================================
// Extracted Tool Info (regex-based, no runtime import needed)
// ============================================================================

interface ExtractedSkillTool {
  toolName: string;
  description: string;
  method: EndpointMethod;
  path: string;
  module?: string;
  allowedRoles?: string[];
  needsApproval?: boolean;
  inputFields: Array<{ name: string; type: string; required: boolean; description?: string }>;
  outputFields: Array<{ name: string; type: string }>;
}

/**
 * Extract tool information from a source file for skill generation.
 * Parses defineEndpointTool / defineUiTool blocks via regex.
 */
async function extractSkillTools(absolutePath: string): Promise<ExtractedSkillTool[]> {
  const content = await readFileSafe(absolutePath);
  const tools: ExtractedSkillTool[] = [];

  // Match endpoint tool blocks
  const endpointBlocks = extractBalancedBlocks(
    content,
    /define(?:Ai)?EndpointTool\(\s*/,
  );

  for (const block of endpointBlocks) {
    const tool = parseToolBlock(block, 'endpoint');
    if (tool) tools.push(tool);
  }

  // Match UI tool blocks (they don't have method/path, so we synthesize POST + /api/ui/{toolName})
  const uiBlocks = extractBalancedBlocks(
    content,
    /define(?:Ai)?UiTool\(\s*/,
  );

  for (const block of uiBlocks) {
    const tool = parseToolBlock(block, 'ui');
    if (tool) tools.push(tool);
  }

  return tools;
}

function parseToolBlock(
  block: string,
  kind: 'endpoint' | 'ui',
): ExtractedSkillTool | null {
  const toolNameMatch = block.match(/toolName\s*:\s*['"`]([^'"`]+)['"`]/);
  if (!toolNameMatch) return null;

  // Match description — handle backtick templates (multiline) and regular quotes
  const descMatch = block.match(/description\s*:\s*`([^`]+)`/) ??
                    block.match(/description\s*:\s*['"]([^'"]+)['"]/);
  const methodMatch = block.match(/method\s*:\s*['"`]([^'"`]+)['"`]/);
  const pathMatch = block.match(/path\s*:\s*['"`]([^'"`]+)['"`]/);
  const moduleMatch = block.match(/module\s*:\s*['"`]([^'"`]+)['"`]/);
  const approvalMatch = block.match(/needsApproval\s*:\s*(true|false)/);

  // Extract allowedRoles
  const rolesMatch = block.match(/allowedRoles\s*:\s*\[([^\]]*)\]/);
  let allowedRoles: string[] | undefined;
  if (rolesMatch) {
    allowedRoles = rolesMatch[1]
      .match(/['"`]([^'"`]+)['"`]/g)
      ?.map((s) => s.replace(/['"`]/g, ''));
  }

  // Extract input fields from z.object({...})
  const inputFields = extractZodFields(block, 'inputSchema');
  const outputFields = extractZodFields(block, 'outputSchema');

  const toolName = toolNameMatch[1];

  return {
    toolName,
    description: descMatch?.[1] ?? `${toolName} tool`,
    method: (methodMatch?.[1] as EndpointMethod) ?? (kind === 'ui' ? 'POST' : 'GET'),
    path: pathMatch?.[1] ?? (kind === 'ui' ? `/api/ui/${toolName}` : `/api/${toolName}`),
    module: moduleMatch?.[1],
    allowedRoles,
    needsApproval: approvalMatch ? approvalMatch[1] === 'true' : undefined,
    inputFields,
    outputFields,
  };
}

/**
 * Extract field names and approximate types from a Zod schema block.
 */
function extractZodFields(
  block: string,
  schemaKey: string,
): Array<{ name: string; type: string; required: boolean; description?: string }> {
  const fields: Array<{ name: string; type: string; required: boolean; description?: string }> = [];

  // Find the schema block: inputSchema: z.object({...})
  const schemaPattern = new RegExp(
    `${schemaKey}\\s*:\\s*z\\.object\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
  );
  const schemaMatch = block.match(schemaPattern);
  if (!schemaMatch) return fields;

  const schemaContent = schemaMatch[1];

  // Match field definitions: fieldName: z.string(), fieldName: z.number().optional(), etc.
  const fieldPattern = /(\w+)\s*:\s*z\.(\w+)\((.*?)\)((?:\.\w+\([^)]*\))*)/g;
  let fieldMatch: RegExpExecArray | null;

  while ((fieldMatch = fieldPattern.exec(schemaContent)) !== null) {
    const name = fieldMatch[1];
    const zodType = fieldMatch[2];
    const chainedMethods = fieldMatch[4] ?? '';

    const isOptional = chainedMethods.includes('.optional()');
    const descriptionMatch = chainedMethods.match(/\.describe\(\s*['"`]([^'"`]+)['"`]\s*\)/);

    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      date: 'string (ISO date)',
      enum: 'string (enum)',
      array: 'array',
      object: 'object',
      uuid: 'string (UUID)',
    };

    fields.push({
      name,
      type: typeMap[zodType] ?? zodType,
      required: !isOptional,
      description: descriptionMatch?.[1],
    });
  }

  return fields;
}

// ============================================================================
// Markdown Skill Generation (Claude Code format)
// ============================================================================

/**
 * Compact tool reference for module files.
 * ~40% fewer lines than the original toolToMarkdown.
 */
function toolToCompactMarkdown(tool: ExtractedSkillTool): string {
  const lines: string[] = [];

  lines.push(`### ${tool.toolName} — \`${tool.method} ${tool.path}\``);
  lines.push(tool.description);

  const meta: string[] = [];
  if (tool.allowedRoles?.length) meta.push(`Roles: ${tool.allowedRoles.join(', ')}`);
  if (tool.needsApproval) meta.push('Requires approval');
  if (meta.length) lines.push(meta.join(' | '));

  if (tool.inputFields.length > 0) {
    lines.push('');
    lines.push('| Param | Type | Req | Description |');
    lines.push('|-------|------|-----|-------------|');
    for (const f of tool.inputFields) {
      lines.push(`| ${f.name} | ${f.type} | ${f.required ? 'yes' : '-'} | ${f.description ?? ''} |`);
    }
  }

  if (tool.outputFields.length > 0) {
    lines.push('');
    lines.push('**Response:**');
    for (const field of tool.outputFields) {
      lines.push(`- \`${field.name}\`: ${field.type}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Original verbose tool markdown (kept for monolithic fallback).
 */
function toolToMarkdown(tool: ExtractedSkillTool, baseUrl: string): string {
  const lines: string[] = [];

  lines.push(`### \`${tool.toolName}\``);
  lines.push('');
  lines.push(tool.description);
  lines.push('');
  lines.push(`- **Method:** \`${tool.method}\``);
  lines.push(`- **Endpoint:** \`${baseUrl}${tool.path}\``);

  if (tool.module) {
    lines.push(`- **Module:** ${tool.module}`);
  }
  if (tool.needsApproval) {
    lines.push(`- **Requires approval:** yes`);
  }
  if (tool.allowedRoles?.length) {
    lines.push(`- **Allowed roles:** ${tool.allowedRoles.join(', ')}`);
  }

  if (tool.inputFields.length > 0) {
    lines.push('');
    lines.push('**Parameters:**');
    lines.push('');
    lines.push('| Name | Type | Required | Description |');
    lines.push('|------|------|----------|-------------|');
    for (const field of tool.inputFields) {
      lines.push(
        `| \`${field.name}\` | ${field.type} | ${field.required ? 'yes' : 'no'} | ${field.description ?? ''} |`,
      );
    }
  }

  if (tool.outputFields.length > 0) {
    lines.push('');
    lines.push('**Response fields:**');
    lines.push('');
    for (const field of tool.outputFields) {
      lines.push(`- \`${field.name}\`: ${field.type}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Modular Skill Generation (one file per module + router)
// ============================================================================

interface SkillFile {
  relativePath: string;
  content: string;
}

/**
 * Build a CSO-optimized description for the router SKILL.md.
 * Lists concrete capabilities the user might ask about.
 */
function buildRouterDescription(
  config: AgentSkillConfig,
  byModule: Map<string, ExtractedSkillTool[]>,
): string {
  const capabilities: string[] = [];
  for (const [moduleName, moduleTools] of byModule) {
    const label = moduleName.replace(/_/g, ' ');
    const verbs = moduleTools
      .slice(0, 3)
      .map((t) => t.toolName.replace(/_/g, ' '))
      .join(', ');
    capabilities.push(`${label} (${verbs})`);
  }

  const authHint = config.auth.type === 'bearer'
    ? `Requires ${(config.auth as { tokenEnvVar: string }).tokenEnvVar} env var.`
    : config.auth.type === 'api-key'
      ? `Requires ${(config.auth as { keyEnvVar: string }).keyEnvVar} env var.`
      : '';

  // Extract user-facing action verbs from tool names for CSO
  const actionVerbs = new Set<string>();
  for (const [, moduleTools] of byModule) {
    for (const t of moduleTools) {
      const verb = t.toolName.split('_')[0];
      if (['list', 'get', 'create', 'update', 'delete', 'assign', 'sync', 'navigate', 'open', 'bulk'].includes(verb)) {
        actionVerbs.add(verb);
      }
    }
  }

  const parts = [
    `Manages ${capabilities.map(c => c.split(' (')[0]).join(', ')} in ${config.appName}.`,
    `Use when user asks to ${Array.from(actionVerbs).slice(0, 6).join('/')} data.`,
    `Covers: ${capabilities.join('; ')}.`,
    authHint,
    config.description ?? '',
  ].filter(Boolean);

  return parts.join(' ').slice(0, 1024);
}

/**
 * Build a CSO-optimized description for a module file.
 */
function buildModuleDescription(
  config: AgentSkillConfig,
  moduleName: string,
  moduleTools: ExtractedSkillTool[],
): string {
  const readCount = moduleTools.filter((t) => t.method === 'GET').length;
  const writeCount = moduleTools.length - readCount;
  const label = moduleName.replace(/_/g, ' ');
  const verbs = moduleTools.map((t) => t.toolName.replace(/_/g, ' ')).join(', ');

  const typeSummary = [
    readCount > 0 ? `${readCount} read` : '',
    writeCount > 0 ? `${writeCount} write` : '',
  ].filter(Boolean).join(', ');

  return `${label} module for ${config.appName} API. Use when: ${verbs}. ${typeSummary} endpoint${moduleTools.length !== 1 ? 's' : ''}.`.slice(0, 1024);
}

/**
 * Generate the router SKILL.md that links to per-module files.
 */
function generateRouterSkill(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
  byModule: Map<string, ExtractedSkillTool[]>,
): string {
  const lines: string[] = [];
  const slug = slugify(config.appName);
  const readTools = tools.filter((t) => t.method === 'GET');
  const writeTools = tools.filter((t) => t.method !== 'GET');

  // Collect all module keywords for triggers
  const allKeywords: string[] = [];
  for (const [moduleName, moduleTools] of byModule) {
    allKeywords.push(moduleName.replace(/_/g, ' '));
    for (const t of moduleTools) {
      allKeywords.push(t.toolName.replace(/_/g, ' '));
    }
  }

  const description = buildRouterDescription(config, byModule);

  // ── YAML Frontmatter ──
  lines.push('---');
  lines.push(`name: managing-${slug}`);
  lines.push(`description: ${description}`);
  lines.push(`compatibility: Requires curl and jq. Needs network access to ${config.baseUrl}.`);
  lines.push(`allowed-tools: "Bash(curl:*) Bash(jq:*)"`);
  lines.push('---');
  lines.push('');

  // ── Title & Overview ──
  lines.push(`# ${config.appName} API`);
  lines.push('');
  lines.push(`**${tools.length} tools** (${readTools.length} read, ${writeTools.length} write) across **${byModule.size} module(s)**.`);
  lines.push('');
  lines.push(`**Base URL:** \`${config.baseUrl}\``);
  lines.push('');

  // ── Authentication ──
  lines.push('## Authentication');
  lines.push('');
  lines.push(generateAuthInstructions(config.auth));
  lines.push('');

  // ── Module Overview Table ──
  lines.push('## Modules');
  lines.push('');
  lines.push('| Module | Tools | Read | Write | Key tools |');
  lines.push('|--------|-------|------|-------|-----------|');
  for (const [moduleName, moduleTools] of byModule) {
    const modSlug = moduleName.replace(/_/g, '-');
    const readCount = moduleTools.filter((t) => t.method === 'GET').length;
    const writeCount = moduleTools.length - readCount;
    const keyTools = moduleTools.slice(0, 3).map((t) => `\`${t.toolName}\``).join(', ');
    lines.push(`| [${moduleName}](${modSlug}.md) | ${moduleTools.length} | ${readCount} | ${writeCount} | ${keyTools} |`);
  }
  lines.push('');

  // ── Request Format ──
  lines.push('## Making Requests');
  lines.push('');
  lines.push('```bash');
  lines.push(`# GET request (read operations)`);
  lines.push(`curl -s -H "Authorization: Bearer $TOKEN" \\`);
  lines.push(`  "${config.baseUrl}/api/<path>" | jq .`);
  lines.push('');
  lines.push(`# POST/PATCH/PUT request (write operations)`);
  lines.push(`curl -s -X POST -H "Authorization: Bearer $TOKEN" \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"key": "value"}' \\`);
  lines.push(`  "${config.baseUrl}/api/<path>" | jq .`);
  lines.push('```');
  lines.push('');

  // ── Destructive Action Warning ──
  if (writeTools.length > 0) {
    lines.push('## Write Operations');
    lines.push('');
    lines.push('Before executing write operations (POST, PATCH, PUT, DELETE):');
    lines.push('');
    lines.push('1. Show the user what data will be modified');
    lines.push('2. If `needsApproval` is marked for the tool, **always ask for confirmation**');
    lines.push('3. After a successful write, report what changed');
    lines.push('');
  }

  // ── Troubleshooting ──
  lines.push('## Troubleshooting');
  lines.push('');
  lines.push('### Error: 401 Unauthorized');
  lines.push('Cause: Token is missing, expired, or invalid.');
  lines.push('Solution: Re-authenticate and obtain a fresh token (see Authentication).');
  lines.push('');
  lines.push('### Error: 403 Forbidden');
  lines.push('Cause: The current user role does not have permission for this tool.');
  lines.push('Solution: Check the `allowedRoles` for the tool and verify the user has the required role.');
  lines.push('');
  lines.push('### Error: 422 Validation Error');
  lines.push('Cause: Request body does not match the expected schema.');
  lines.push('Solution: Check the parameter table for the tool and ensure all required fields are provided with correct types.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a per-module skill file with compact tool references.
 */
function generateModuleSkill(
  config: AgentSkillConfig,
  moduleName: string,
  moduleTools: ExtractedSkillTool[],
): string {
  const lines: string[] = [];
  const slug = slugify(config.appName);
  const modSlug = moduleName.replace(/_/g, '-');
  const description = buildModuleDescription(config, moduleName, moduleTools);

  const readTools = moduleTools.filter((t) => t.method === 'GET');
  const writeTools = moduleTools.filter((t) => t.method !== 'GET');

  // ── YAML Frontmatter ──
  lines.push('---');
  lines.push(`name: ${slug}-api-${modSlug}`);
  lines.push(`description: ${description}`);
  lines.push('---');
  lines.push('');

  // ── Title ──
  const label = moduleName.replace(/_/g, ' ');
  lines.push(`# ${label}`);
  lines.push('');
  lines.push(`${moduleTools.length} tools (${readTools.length} read, ${writeTools.length} write) | Base URL: \`${config.baseUrl}\``);
  lines.push('');

  // ── Tool Reference ──
  lines.push('## Tools');
  lines.push('');

  for (const tool of moduleTools) {
    lines.push(toolToCompactMarkdown(tool));
  }

  // ── Examples ──
  const exampleReadTool = readTools[0];
  const exampleWriteTool = writeTools[0];

  if (exampleReadTool || exampleWriteTool) {
    lines.push('## Examples');
    lines.push('');

    if (exampleReadTool) {
      lines.push(`### Read: ${exampleReadTool.toolName.replace(/_/g, ' ')}`);
      lines.push('');
      lines.push('```bash');
      lines.push(`curl -s -H "Authorization: Bearer $TOKEN" \\`);
      lines.push(`  "${config.baseUrl}${exampleReadTool.path}" | jq .`);
      lines.push('```');
      lines.push('');
    }

    if (exampleWriteTool) {
      const bodyFields = exampleWriteTool.inputFields
        .filter((f) => f.required)
        .map((f) => `"${f.name}": "<value>"`)
        .join(', ');
      lines.push(`### Write: ${exampleWriteTool.toolName.replace(/_/g, ' ')}`);
      lines.push('');
      lines.push('```bash');
      lines.push(`curl -s -X ${exampleWriteTool.method} -H "Authorization: Bearer $TOKEN" \\`);
      lines.push(`  -H "Content-Type: application/json" \\`);
      lines.push(`  -d '{${bodyFields}}' \\`);
      lines.push(`  "${config.baseUrl}${exampleWriteTool.path}" | jq .`);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate modular skill files: one router SKILL.md + one file per module.
 * Returns an array of { relativePath, content } for the caller to write.
 */
function generateModularSkills(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
): SkillFile[] {
  const files: SkillFile[] = [];

  // Group tools by module
  const byModule = new Map<string, ExtractedSkillTool[]>();
  for (const tool of tools) {
    const mod = tool.module ?? 'general';
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(tool);
  }

  // Generate router SKILL.md
  files.push({
    relativePath: 'SKILL.md',
    content: generateRouterSkill(config, tools, byModule),
  });

  // Generate per-module files
  for (const [moduleName, moduleTools] of byModule) {
    const modSlug = moduleName.replace(/_/g, '-');
    files.push({
      relativePath: `${modSlug}.md`,
      content: generateModuleSkill(config, moduleName, moduleTools),
    });
  }

  return files;
}

/**
 * Generate a single monolithic SKILL.md (legacy fallback).
 * Renamed from the original generateMarkdownSkill.
 */
function generateMonolithicSkill(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
): string {
  const lines: string[] = [];
  const slug = slugify(config.appName);

  // Group tools by module (needed for multiple sections)
  const byModule = new Map<string, ExtractedSkillTool[]>();
  for (const tool of tools) {
    const mod = tool.module ?? 'general';
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(tool);
  }

  const moduleNames = Array.from(byModule.keys());
  const readTools = tools.filter((t) => t.method === 'GET');
  const writeTools = tools.filter((t) => t.method !== 'GET');

  // ── YAML Frontmatter (Anthropic spec: name + description required) ──
  // description: what it does + when to use it + trigger phrases (max 1024 chars)
  const triggerPhrases = moduleNames.slice(0, 4).map((m) => m.replace(/_/g, ' ')).join(', ');
  const descriptionParts = [
    `Interact with the ${config.appName} platform API.`,
    `Use when the user wants to query or modify data via ${config.appName},`,
    `mentions ${triggerPhrases},`,
    `or asks to call the ${config.appName} API.`,
    config.description ? config.description : '',
  ].filter(Boolean);
  const description = descriptionParts.join(' ').slice(0, 1024);

  lines.push('---');
  lines.push(`name: ${slug}-api`);
  lines.push(`description: ${description}`);
  if (config.version) {
    lines.push(`metadata:`);
    lines.push(`  version: ${config.version}`);
    lines.push(`  author: auto-generated by glirastes`);
    lines.push(`  category: platform-api`);
  }
  lines.push(`compatibility: Requires curl and jq. Needs network access to ${config.baseUrl}.`);
  lines.push(`allowed-tools: "Bash(curl:*) Bash(jq:*)"`)
  lines.push('---');
  lines.push('');

  // ── Title & Overview ──
  lines.push(`# ${config.appName} API`);
  lines.push('');
  lines.push(`This skill gives you access to the ${config.appName} platform API.`);
  lines.push(`It exposes **${tools.length} tools** (${readTools.length} read, ${writeTools.length} write) across **${byModule.size} module(s)**.`);
  lines.push('');
  lines.push(`**Base URL:** \`${config.baseUrl}\``);
  lines.push('');

  // ── Instructions ──
  lines.push('## Instructions');
  lines.push('');

  // Step 1: Authentication
  lines.push('### Step 1: Authenticate');
  lines.push('');
  lines.push(generateAuthInstructions(config.auth));
  lines.push('');

  // Step 2: Choose the right tool
  lines.push('### Step 2: Choose the right tool');
  lines.push('');
  lines.push('Select a tool based on the user\'s intent:');
  lines.push('');
  for (const [moduleName, moduleTools] of byModule) {
    const readCount = moduleTools.filter((t) => t.method === 'GET').length;
    const writeCount = moduleTools.length - readCount;
    lines.push(`- **${moduleName}**: ${moduleTools.map((t) => `\`${t.toolName}\``).join(', ')} (${readCount} read, ${writeCount} write)`);
  }
  lines.push('');

  // Step 3: Make the request
  lines.push('### Step 3: Make the request');
  lines.push('');
  lines.push('```bash');
  lines.push(`# GET request (read operations)`);
  lines.push(`curl -s -H "Authorization: Bearer $TOKEN" \\`);
  lines.push(`  "${config.baseUrl}/api/<path>" | jq .`);
  lines.push('');
  lines.push(`# POST/PATCH/PUT request (write operations)`);
  lines.push(`curl -s -X POST -H "Authorization: Bearer $TOKEN" \\`);
  lines.push(`  -H "Content-Type: application/json" \\`);
  lines.push(`  -d '{"key": "value"}' \\`);
  lines.push(`  "${config.baseUrl}/api/<path>" | jq .`);
  lines.push('```');
  lines.push('');

  // Step 4: Confirm destructive actions
  if (writeTools.length > 0) {
    lines.push('### Step 4: Confirm destructive actions');
    lines.push('');
    lines.push('Before executing write operations (POST, PATCH, PUT, DELETE):');
    lines.push('');
    lines.push('1. Show the user what data will be modified');
    lines.push('2. If `needsApproval` is marked for the tool, **always ask for confirmation**');
    lines.push('3. After a successful write, report what changed');
    lines.push('');
  }

  // ── Tool Reference (grouped by module) ──
  lines.push('## Tool Reference');
  lines.push('');

  for (const [moduleName, moduleTools] of byModule) {
    lines.push(`### Module: ${moduleName}`);
    lines.push('');

    for (const tool of moduleTools) {
      lines.push(toolToMarkdown(tool, config.baseUrl));
    }
  }

  // ── Examples ──
  lines.push('## Examples');
  lines.push('');

  // Auto-generate examples from actual tools
  const exampleReadTool = readTools[0];
  const exampleWriteTool = writeTools[0];

  if (exampleReadTool) {
    lines.push(`### Example 1: Read data`);
    lines.push('');
    lines.push(`User says: "Show me the ${exampleReadTool.toolName.replace(/_/g, ' ').replace(/^(list|get) /, '')}"`);
    lines.push('');
    lines.push('Actions:');
    lines.push(`1. Authenticate with the API`);
    lines.push(`2. Call \`${exampleReadTool.method} ${config.baseUrl}${exampleReadTool.path}\``);
    lines.push(`3. Format and display results to the user`);
    lines.push('');
    lines.push('```bash');
    lines.push(`curl -s -H "Authorization: Bearer $TOKEN" \\`);
    lines.push(`  "${config.baseUrl}${exampleReadTool.path}" | jq .`);
    lines.push('```');
    lines.push('');
  }

  if (exampleWriteTool) {
    lines.push(`### Example 2: Write data`);
    lines.push('');
    lines.push(`User says: "${exampleWriteTool.toolName.replace(/_/g, ' ')}"`);
    lines.push('');
    lines.push('Actions:');
    lines.push(`1. Authenticate with the API`);
    lines.push(`2. Confirm the action with the user${exampleWriteTool.needsApproval ? ' (requires approval)' : ''}`);
    const bodyFields = exampleWriteTool.inputFields
      .filter((f) => f.required)
      .map((f) => `"${f.name}": "<value>"`)
      .join(', ');
    lines.push(`3. Call \`${exampleWriteTool.method} ${config.baseUrl}${exampleWriteTool.path}\` with body \`{${bodyFields}}\``);
    lines.push(`4. Report the result`);
    lines.push('');
  }

  // ── Troubleshooting ──
  lines.push('## Troubleshooting');
  lines.push('');
  lines.push('### Error: 401 Unauthorized');
  lines.push('Cause: Token is missing, expired, or invalid.');
  lines.push('Solution: Re-authenticate and obtain a fresh token (see Step 1).');
  lines.push('');
  lines.push('### Error: 403 Forbidden');
  lines.push('Cause: The current user role does not have permission for this tool.');
  lines.push('Solution: Check the `allowedRoles` for the tool and verify the user has the required role.');
  lines.push('');
  lines.push('### Error: 422 Validation Error');
  lines.push('Cause: Request body does not match the expected schema.');
  lines.push('Solution: Check the parameter table for the tool and ensure all required fields are provided with correct types.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate auth instructions in a step-by-step format (for the Instructions section).
 */
function generateAuthInstructions(auth: AgentAuthStrategy): string {
  switch (auth.type) {
    case 'bearer':
      return [
        `This API uses **Bearer token** authentication.`,
        ``,
        `\`\`\`bash`,
        `# Ensure the token is available`,
        `TOKEN="\$${auth.tokenEnvVar}"`,
        ``,
        `# Every request must include:`,
        `#   -H "Authorization: Bearer $TOKEN"`,
        `\`\`\``,
        ``,
        `Expected result: Requests return 200. If you get 401, the token is missing or expired.`,
        auth.description ? `\n${auth.description}` : '',
      ].join('\n');

    case 'api-key':
      return [
        `This API uses **API key** authentication via the \`${auth.headerName}\` header.`,
        ``,
        `\`\`\`bash`,
        `API_KEY="\$${auth.keyEnvVar}"`,
        ``,
        `# Every request must include:`,
        `#   -H "${auth.headerName}: $API_KEY"`,
        `\`\`\``,
        ``,
        `Expected result: Requests return 200. If you get 401, the API key is invalid.`,
        auth.description ? `\n${auth.description}` : '',
      ].join('\n');

    case 'oauth2':
      return [
        `This API uses **OAuth 2.0 Client Credentials** flow.`,
        ``,
        `\`\`\`bash`,
        `# 1. Obtain access token`,
        `TOKEN=$(curl -s -X POST ${auth.tokenUrl} \\`,
        `  -d "grant_type=client_credentials" \\`,
        `  -d "client_id=\$${auth.clientIdEnvVar}" \\`,
        `  -d "client_secret=\$${auth.clientSecretEnvVar}"${auth.scopes ? ` \\\n  -d "scope=${auth.scopes.join(' ')}"` : ''} \\`,
        `  | jq -r '.access_token')`,
        ``,
        `# 2. Verify token was obtained`,
        `[ -n "$TOKEN" ] && echo "Auth OK" || echo "Auth FAILED"`,
        `\`\`\``,
        ``,
        `Expected result: "Auth OK". If "Auth FAILED", check client credentials.`,
        auth.description ? `\n${auth.description}` : '',
      ].join('\n');

    case 'cookie':
      return [
        `This API uses **cookie-based** session authentication.`,
        `The agent must first authenticate via the login endpoint and pass cookies in subsequent requests.`,
        ``,
        `\`\`\`bash`,
        `# Store cookies from login`,
        `curl -s -c cookies.txt -X POST <login-url> \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"username": "...", "password": "..."}'`,
        ``,
        `# Use cookies in subsequent requests`,
        `curl -s -b cookies.txt <api-url>`,
        `\`\`\``,
        auth.description ? `\n${auth.description}` : '',
      ].join('\n');
  }
}

// ============================================================================
// JSON Manifest Generation (machine-readable for Codex / Agent SDK)
// ============================================================================

function toolToJsonSchema(tool: ExtractedSkillTool): AgentSkillTool {
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties: {} as Record<string, unknown>,
    required: [] as string[],
  };

  for (const field of tool.inputFields) {
    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      'string (ISO date)': 'string',
      'string (enum)': 'string',
      'string (UUID)': 'string',
      array: 'array',
      object: 'object',
    };

    const prop: Record<string, unknown> = {
      type: typeMap[field.type] ?? 'string',
    };
    if (field.description) prop.description = field.description;
    if (field.type === 'string (UUID)') prop.format = 'uuid';
    if (field.type === 'string (ISO date)') prop.format = 'date-time';

    (parameters.properties as Record<string, unknown>)[field.name] = prop;
    if (field.required) {
      (parameters.required as string[]).push(field.name);
    }
  }

  const result: AgentSkillTool = {
    name: tool.toolName,
    description: tool.description,
    method: tool.method,
    path: tool.path,
    parameters,
  };

  if (tool.outputFields.length > 0) {
    const response: Record<string, unknown> = {
      type: 'object',
      properties: {} as Record<string, unknown>,
    };
    for (const field of tool.outputFields) {
      (response.properties as Record<string, unknown>)[field.name] = {
        type: field.type === 'number' ? 'number' : 'string',
      };
    }
    result.response = response;
  }

  if (tool.needsApproval) result.needsApproval = true;

  return result;
}

interface AgentSkillManifest {
  name: string;
  description: string;
  version?: string;
  baseUrl: string;
  auth: AgentAuthStrategy;
  tools: AgentSkillTool[];
  modules: Record<string, string[]>;
}

function generateJsonManifest(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
): AgentSkillManifest {
  const modules: Record<string, string[]> = {};
  for (const tool of tools) {
    const mod = tool.module ?? 'general';
    if (!modules[mod]) modules[mod] = [];
    modules[mod].push(tool.toolName);
  }

  return {
    name: `${slugify(config.appName)}-api`,
    description: config.description ?? `Agent skill for ${config.appName} platform API`,
    version: config.version,
    baseUrl: config.baseUrl,
    auth: config.auth,
    tools: tools.map(toolToJsonSchema),
    modules,
  };
}

// ============================================================================
// Optimize Meta-Skill Template
// ============================================================================

/**
 * Generate the "optimize-generated-skills" meta-skill SKILL.md.
 * This skill teaches a coding agent how to review and upgrade the
 * auto-generated API skills to production quality.
 *
 * Replaces {APP_NAME} with the actual app name slug.
 */
function generateOptimizeSkillTemplate(appName: string): string {
  const slug = slugify(appName);
  return `---
name: optimize-generated-skills
description: Use after running \`glirastes generate-skills\` to review and improve auto-generated API skill files. Covers frontmatter CSO, token efficiency, description quality, parameter completeness, and adding domain context the generator cannot infer.
---

# Optimize Generated Skills

## Overview

Auto-generated skills from \`glirastes generate-skills\` are structurally correct but lack domain context, workflow knowledge, and CSO polish. This skill guides you through reviewing and upgrading them to production quality.

**Target:** The generated skill at \`./${slug}-api/SKILL.md\` and its module files.

## When to Use

- Right after running \`glirastes generate-skills\`
- When an agent struggles to find or use the generated skill correctly
- When adding new tools and regenerating (review diff, preserve manual additions)

## Review Process

Work through each step in order. After each step, re-read the file to verify changes.

### Step 1: Router SKILL.md

Open \`./${slug}-api/SKILL.md\` and check:

**Frontmatter:**
- \`description\` starts with "Use when..." (not "Interact with..." or "Tool for...")
- Includes searchable keywords: module names, key tool names, error codes (401, 403, 422)
- Under 500 characters; no workflow summary (CSO: triggers only, never process)
- \`allowed-tools\` matches what the agent actually needs (curl, jq, etc.)

**Body:**
- Module table is accurate (tool counts, key tools)
- Auth section has correct env var names
- Total line count < 100

### Step 2: Module Files

For each \`<module>.md\` in \`./${slug}-api/\`:

**Descriptions:**
- Replace generic "Tool for X" with actionable descriptions
- Include WHEN to use: \`"Use to look up user UUIDs before assigning tasks"\`
- Include WHAT it returns: \`"Returns list with IDs, titles, status"\`
- Add LLM hints for mutations: \`"IMPORTANT: ask for title first"\`, \`"DO NOT invent IDs"\`

**Parameter tables:**
- Every required field has a description (not blank)
- Types match actual API behavior (e.g., \`string (UUID)\` not just \`string\`)
- Optional fields explain when to use them

**Language consistency:**
- All descriptions in one language (all English OR all German, not mixed)
- If the consumer app's UI language differs from English, match it

**Line count:**
- Each module file < 500 lines
- If over 500: split into sub-modules or compress rarely-used tools into a summary table

### Step 3: Token Efficiency

**Router:** Should be < 100 lines. If longer:
- Move troubleshooting to a separate \`troubleshooting.md\` (only if > 3 error patterns)
- Keep auth and module table inline

**Module files:** Compress where possible:
- Collapse tools with identical parameter shapes into a single entry with variants
- Remove empty "Response" sections
- Use \`--help\` references instead of documenting every optional param

**Rarely-used tools:** If a module has > 15 tools:
- Move rarely-used ones to an "Additional Tools" section at the bottom
- Keep the top 5-8 most common tools prominent

### Step 4: Domain Context

This is the highest-value step. Add knowledge the generator cannot infer:

**Business rules:**
\`\`\`markdown
## Business Rules
- Tasks can only be assigned to members of the same group
- Deleting a group reassigns all tasks to "unassigned"
- Holiday calendar entries require admin role
\`\`\`

**Common workflows:**
\`\`\`markdown
## Common Workflows

### Move a task to another group
1. \`list_groups\` to get target group ID
2. \`update_task\` with new \`groupId\`
Note: task keeps its assignee only if assignee is in the target group.
\`\`\`

**Error recovery:**
\`\`\`markdown
## Error Recovery
- 409 Conflict on task update: re-fetch the task (optimistic locking)
- 422 on create with assigneeId: the user UUID is wrong, use \`find_user\` first
\`\`\`

**Cross-module references:**
\`\`\`markdown
<!-- In task-mutation.md -->
**Prerequisite:** Use \`find_user\` (in [group-management](group-management.md)) to resolve user names to UUIDs before assigning.
\`\`\`

### Step 5: Verify

Run through this checklist and fix any remaining issues:

\`\`\`
- [ ] Router SKILL.md < 100 lines
- [ ] Each module file < 500 lines
- [ ] All descriptions are specific (no "Tool for X" patterns)
- [ ] Language is consistent per file
- [ ] Parameter descriptions filled in for required fields
- [ ] Common workflows documented (at least 2)
- [ ] Error codes and symptoms in frontmatter keywords
- [ ] Cross-references between related modules
- [ ] Business rules section added where applicable
- [ ] Auth env var name matches actual .env
\`\`\`

## After Optimization

- Commit the optimized files (they live in \`.claude/skills/generated/\`)
- Note: re-running \`glirastes generate-skills\` will overwrite your changes
- To preserve manual additions across regeneration, consider moving domain context to a separate file (e.g., \`${slug}-api/domain-context.md\`) and referencing it from the module files

## Anti-Patterns

| Pattern | Fix |
|---------|-----|
| "Tool for creating items" | "Create a new item. Ask for title first. Returns the created item with its UUID." |
| Empty parameter descriptions | Fill in what the parameter does and any constraints |
| Mixed English/German in one file | Pick one language, be consistent |
| 800-line module file | Split by sub-domain or compress rarely-used tools |
| Workflow in frontmatter description | Move to body; description = triggers only |
| Duplicated auth instructions in modules | Reference router SKILL.md instead |
`;
}

// ============================================================================
// Public API
// ============================================================================

export interface GenerateSkillsOptions extends GenerateOptions {
  /** Skill configuration (app name, base URL, auth) */
  skillConfig: AgentSkillConfig;
  /** Output format(s) to generate */
  formats?: Array<'markdown' | 'json'>;
  /** Custom output directory for skill files (default: .claude/skills/generated/) */
  skillOutputDir?: string;
}

export interface GenerateSkillsResult {
  markdownPath?: string;
  /** Paths of all generated markdown files (modular output) */
  markdownPaths?: string[];
  jsonPath?: string;
  toolCount: number;
  moduleCount: number;
  /** Full extracted tool metadata for syncing to Glirastes */
  tools: Array<{
    toolName: string;
    description: string;
    method: string;
    path: string;
    module?: string;
    allowedRoles?: string[];
    needsApproval?: boolean;
    inputFields: Array<{ name: string; type: string; required: boolean; description?: string }>;
    outputFields: Array<{ name: string; type: string }>;
  }>;
}

/**
 * Generate agent skill files from discovered tool definitions.
 *
 * Scans the project for endpoint and UI tool definitions and produces:
 * - Modular Markdown skill files (one router SKILL.md + one file per module)
 * - A JSON manifest (machine-readable for Codex / Agent SDK)
 *
 * Both formats contain the full tool catalog with auth instructions,
 * enabling autonomous agents to interact with the platform API.
 */
export async function generateAgentSkills(
  options: GenerateSkillsOptions,
): Promise<GenerateSkillsResult> {
  const opts = resolveDefaults(options);
  const formats = options.formats ?? ['markdown', 'json'];
  const outputDir = options.skillOutputDir
    ? join(opts.rootDir, options.skillOutputDir)
    : join(opts.rootDir, '.claude', 'skills', 'generated');

  // Scan all tool files
  const endpointScan = await scanEndpointTools(options);
  const uiScan = await scanUiTools(options);

  // Extract tool metadata from all discovered files
  const allTools: ExtractedSkillTool[] = [];
  for (const file of [...endpointScan.files, ...uiScan.files]) {
    const tools = await extractSkillTools(file.absolutePath);
    allTools.push(...tools);
  }

  // Count modules
  const moduleSet = new Set(allTools.map((t) => t.module ?? 'general'));

  await mkdir(outputDir, { recursive: true });

  const result: GenerateSkillsResult = {
    toolCount: allTools.length,
    moduleCount: moduleSet.size,
    tools: allTools,
  };

  // Generate modular Markdown skills — one router + one file per module:
  // .claude/skills/generated/<app>-api/SKILL.md  (router)
  // .claude/skills/generated/<app>-api/<module>.md (per module)
  if (formats.includes('markdown')) {
    const skillFiles = generateModularSkills(options.skillConfig, allTools);
    const skillFolderName = `${slugify(options.skillConfig.appName)}-api`;
    const skillDir = join(outputDir, skillFolderName);
    await mkdir(skillDir, { recursive: true });

    const writtenPaths: string[] = [];
    for (const file of skillFiles) {
      const filePath = join(skillDir, file.relativePath);
      await writeFile(filePath, file.content, 'utf-8');
      writtenPaths.push(filePath);
    }

    // markdownPath points to the router SKILL.md for backward compat
    result.markdownPath = join(skillDir, 'SKILL.md');
    result.markdownPaths = writtenPaths;

    // Generate optimize meta-skill alongside the API skill
    const optimizeDir = join(outputDir, 'optimize-generated-skills');
    await mkdir(optimizeDir, { recursive: true });
    const optimizeContent = generateOptimizeSkillTemplate(options.skillConfig.appName);
    const optimizePath = join(optimizeDir, 'SKILL.md');
    await writeFile(optimizePath, optimizeContent, 'utf-8');
    writtenPaths.push(optimizePath);

    if (!opts.quiet) {
      console.log(`\u2713 Generated skill (Markdown, modular): ${writtenPaths.length} files in ${skillDir}`);
      for (const p of writtenPaths) {
        console.log(`  - ${p}`);
      }
    }
  }

  // Generate JSON manifest
  if (formats.includes('json')) {
    const manifest = generateJsonManifest(options.skillConfig, allTools);
    const jsonPath = join(outputDir, `${slugify(options.skillConfig.appName)}-api.skill.json`);
    await writeFile(jsonPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    result.jsonPath = jsonPath;

    if (!opts.quiet) {
      console.log(`\u2713 Generated skill (JSON): ${jsonPath}`);
    }
  }

  if (!opts.quiet) {
    console.log(`  ${allTools.length} tools across ${moduleSet.size} modules`);
  }

  return result;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
