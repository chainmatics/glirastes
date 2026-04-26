import { readFileSafe, extractBalancedBlocks } from './fs-utils.js';
import { scanEndpointTools } from './endpoint-scanner.js';
import { scanUiTools } from './ui-scanner.js';
import type { GenerateOptions } from './types.js';
import { resolveDefaults } from './types.js';
import type {
  AgentSkillConfig,
  AgentAuthStrategy,
  EndpointMethod,
} from '../types.js';

// ============================================================================
// Extracted Tool Info (shared shape with skill-generator)
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
 * Extract tool information from a source file for MCP generation.
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
// MCP Server Code Generation
// ============================================================================

/**
 * Map extracted Zod type strings to Zod builder calls for generated code.
 */
function zodTypeToCode(field: { name: string; type: string; required: boolean; description?: string }): string {
  const typeMap: Record<string, string> = {
    'string': 'z.string()',
    'number': 'z.number()',
    'boolean': 'z.boolean()',
    'string (ISO date)': 'z.string()',
    'string (enum)': 'z.string()',
    'string (UUID)': 'z.string()',
    'array': 'z.array(z.string())',
    'object': 'z.record(z.string())',
  };

  let code = typeMap[field.type] ?? 'z.string()';

  if (field.description) {
    code += `.describe(${JSON.stringify(field.description)})`;
  }

  if (!field.required) {
    code += '.optional()';
  }

  return code;
}

/**
 * Generate the Zod schema object literal for a tool's input fields.
 */
function generateZodSchema(fields: ExtractedSkillTool['inputFields']): string {
  if (fields.length === 0) return '{}';

  const entries = fields.map(
    (f) => `    ${f.name}: ${zodTypeToCode(f)},`,
  );
  return `{\n${entries.join('\n')}\n  }`;
}

/**
 * Generate a single MCP tool registration block.
 */
function generateToolRegistration(tool: ExtractedSkillTool, baseUrl: string): string {
  const schema = generateZodSchema(tool.inputFields);
  const httpMethod = tool.method;
  const fullPath = `${baseUrl}${tool.path}`;

  // Build the fetch call based on HTTP method
  const hasBody = httpMethod !== 'GET' && httpMethod !== 'DELETE';
  const fetchOptions = hasBody
    ? `{
      method: '${httpMethod}',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }`
    : `{
      method: '${httpMethod}',
      headers: authHeaders(),
    }`;

  // Build URL — substitute path params like :id with params.id
  const pathParams = tool.path.match(/:(\w+)/g);
  let urlExpr: string;
  if (pathParams) {
    const paramNames = pathParams.map((p) => p.slice(1));
    let urlTemplate = fullPath;
    for (const param of paramNames) {
      urlTemplate = urlTemplate.replace(`:${param}`, `\${params.${param}}`);
    }
    urlExpr = `\`${urlTemplate}\``;
  } else {
    urlExpr = `'${fullPath}'`;
  }

  return `server.tool(
  '${tool.toolName}',
  ${JSON.stringify(tool.description)},
  ${schema},
  async (params) => {
    const response = await fetch(${urlExpr}, ${fetchOptions});
    const data = await response.json();

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: \`Error \${response.status}: \${JSON.stringify(data)}\` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    };
  },
);`;
}

/**
 * Shorten a description to max ~180 chars, English, first sentence only.
 */
function shortenDescription(desc: string): string {
  // Take first sentence only
  const first = desc.split(/\n/)[0].replace(/\s+/g, ' ').trim();
  // Truncate to 180 chars
  if (first.length <= 180) return first;
  return first.slice(0, 177) + '...';
}

/**
 * Build the tool registry as a JSON structure for the layered server.
 */
function buildToolRegistry(tools: ExtractedSkillTool[], baseUrl: string): string {
  const entries = tools.map(t => {
    const params: Record<string, string> = {};
    for (const f of t.inputFields) {
      const typeStr = f.type === 'array' ? 'string[]' :
                      f.type === 'object' ? 'object' :
                      f.type.startsWith('string') ? 'string' :
                      f.type;
      params[f.name] = `${typeStr}${f.required ? '' : '?'}`;
    }
    return `  {
    name: ${JSON.stringify(t.toolName)},
    description: ${JSON.stringify(shortenDescription(t.description))},
    method: ${JSON.stringify(t.method)},
    path: ${JSON.stringify(t.path)},
    module: ${JSON.stringify(t.module ?? 'general')},
    params: ${JSON.stringify(params)},
  }`;
  });

  return `[\n${entries.join(',\n')}\n]`;
}

/**
 * Generate the server.ts file content using layered tool design.
 *
 * Instead of registering 93 individual tools (which costs ~74K tokens),
 * this generates 3 meta-tools:
 * - search_tools: Find tools by keyword (returns name + description only)
 * - describe_tool: Get full schema for a specific tool
 * - call_tool: Execute a tool with parameters
 *
 * This reduces token cost from ~74K to ~3K (96% reduction).
 */
function generateServerFile(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
): string {
  const slug = slugify(config.appName);
  const registry = buildToolRegistry(tools, config.baseUrl);

  return `// Generated MCP Server for ${config.appName}
// Auto-generated by glirastes
// Layered design: 3 meta-tools instead of ${tools.length} flat tools (~96% token reduction)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { authHeaders } from './auth.js';

const BASE_URL = process.env.BASE_URL ?? '${config.baseUrl}';

const server = new McpServer({
  name: '${slug}',
  version: '${config.version ?? '1.0.0'}',
});

// Tool registry — ${tools.length} tools across ${new Set(tools.map(t => t.module ?? 'general')).size} modules
const TOOLS: Array<{
  name: string;
  description: string;
  method: string;
  path: string;
  module: string;
  params: Record<string, string>;
}> = ${registry};

// --- Meta-tool 1: Search tools by keyword ---
server.tool(
  'search_tools',
  'Find available API tools by keyword or module name. Returns matching tool names with descriptions.',
  {
    query: z.string().describe('Keyword to search in tool names and descriptions'),
    module: z.string().optional().describe('Filter by module name'),
    limit: z.number().optional().describe('Max results (default 10)'),
  },
  async (params) => {
    const q = params.query.toLowerCase();
    const limit = params.limit ?? 10;
    const matches = TOOLS
      .filter(t => {
        if (params.module && t.module !== params.module) return false;
        return t.name.includes(q) || t.description.toLowerCase().includes(q) || t.module.includes(q);
      })
      .slice(0, limit)
      .map(t => ({ name: t.name, description: t.description, module: t.module, method: t.method }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ matches, total: matches.length, modules: [...new Set(TOOLS.map(t => t.module))] }, null, 2) }],
    };
  },
);

// --- Meta-tool 2: Describe a specific tool ---
server.tool(
  'describe_tool',
  'Get full details and parameter schema for a specific tool by name.',
  {
    name: z.string().describe('Exact tool name from search_tools results'),
  },
  async (params) => {
    const tool = TOOLS.find(t => t.name === params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: \`Tool "\${params.name}" not found. Use search_tools to find available tools.\` }], isError: true };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(tool, null, 2) }],
    };
  },
);

// --- Meta-tool 3: Execute a tool ---
server.tool(
  'call_tool',
  'Execute an API tool by name with the given parameters.',
  {
    name: z.string().describe('Tool name to execute'),
    params: z.record(z.unknown()).optional().describe('Tool parameters as key-value pairs'),
  },
  async (args) => {
    const tool = TOOLS.find(t => t.name === args.name);
    if (!tool) {
      return { content: [{ type: 'text', text: \`Tool "\${args.name}" not found.\` }], isError: true };
    }

    const toolParams = args.params ?? {};

    // Build URL — substitute path params like :id
    let url = \`\${BASE_URL}\${tool.path}\`;
    const pathParams = tool.path.match(/:([\\w]+)/g);
    if (pathParams) {
      for (const p of pathParams) {
        const key = p.slice(1);
        const val = toolParams[key];
        if (val !== undefined) {
          url = url.replace(p, String(val));
          delete toolParams[key];
        }
      }
    }

    // Build query string for GET requests with remaining params
    if (tool.method === 'GET' && Object.keys(toolParams).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(toolParams)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      url += \`?\${qs.toString()}\`;
    }

    const hasBody = tool.method !== 'GET' && tool.method !== 'DELETE';
    const fetchOpts: RequestInit = {
      method: tool.method,
      headers: hasBody
        ? { ...authHeaders(), 'Content-Type': 'application/json' }
        : authHeaders(),
    };
    if (hasBody && Object.keys(toolParams).length > 0) {
      fetchOpts.body = JSON.stringify(toolParams);
    }

    try {
      const response = await fetch(url, fetchOpts);
      const data = await response.json();

      if (!response.ok) {
        return {
          content: [{ type: 'text', text: \`Error \${response.status}: \${JSON.stringify(data)}\` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: \`Request failed: \${err instanceof Error ? err.message : String(err)}\` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
`;
}

/**
 * Generate the auth.ts helper file content.
 */
function generateAuthFile(auth: AgentAuthStrategy): string {
  switch (auth.type) {
    case 'bearer':
      return `// Auth helper for ${auth.type} authentication
// Auto-generated by glirastes — do not edit manually.

const TOKEN = process.env.${auth.tokenEnvVar};

if (!TOKEN) {
  console.error('Missing environment variable: ${auth.tokenEnvVar}');
  process.exit(1);
}

/**
 * Returns authorization headers for API requests.
 */
export function authHeaders(): Record<string, string> {
  return {
    Authorization: \`Bearer \${TOKEN}\`,
  };
}
`;

    case 'api-key':
      return `// Auth helper for API key authentication
// Auto-generated by glirastes — do not edit manually.

const API_KEY = process.env.${auth.keyEnvVar};

if (!API_KEY) {
  console.error('Missing environment variable: ${auth.keyEnvVar}');
  process.exit(1);
}

/**
 * Returns authorization headers for API requests.
 */
export function authHeaders(): Record<string, string> {
  return {
    '${auth.headerName}': API_KEY!,
  };
}
`;

    case 'oauth2':
      return `// Auth helper for OAuth 2.0 Client Credentials authentication
// Auto-generated by glirastes — do not edit manually.

const CLIENT_ID = process.env.${auth.clientIdEnvVar};
const CLIENT_SECRET = process.env.${auth.clientSecretEnvVar};
const TOKEN_URL = '${auth.tokenUrl}';
${auth.scopes ? `const SCOPES = '${auth.scopes.join(' ')}';` : ''}

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing environment variables: ${auth.clientIdEnvVar}, ${auth.clientSecretEnvVar}');
  process.exit(1);
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Obtain an access token via the OAuth 2.0 Client Credentials flow.
 */
async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID!,
    client_secret: CLIENT_SECRET!,
    ${auth.scopes ? 'scope: SCOPES,' : ''}
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(\`OAuth token request failed: \${response.status}\`);
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  cachedToken = data.access_token;
  // Refresh 60s before expiry
  tokenExpiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
  return cachedToken;
}

/**
 * Returns authorization headers for API requests.
 */
export function authHeaders(): Record<string, string> {
  // For OAuth2, we need async token fetch — but MCP tool handlers are async,
  // so we cache the token synchronously after first fetch.
  if (!cachedToken) {
    throw new Error('Call ensureAuth() before making requests');
  }
  return {
    Authorization: \`Bearer \${cachedToken}\`,
  };
}

/**
 * Ensure a valid token is available. Call once at startup.
 */
export async function ensureAuth(): Promise<void> {
  await getToken();
}
`;

    case 'cookie':
      return `// Auth helper for cookie-based authentication
// Auto-generated by glirastes — do not edit manually.

let sessionCookie: string | null = null;

/**
 * Set the session cookie obtained from login.
 */
export function setSessionCookie(cookie: string): void {
  sessionCookie = cookie;
}

/**
 * Returns authorization headers for API requests.
 */
export function authHeaders(): Record<string, string> {
  if (!sessionCookie) {
    return {};
  }
  return {
    Cookie: sessionCookie,
  };
}
`;

  }
}

/**
 * Generate the types.ts file content with Zod schemas.
 */
function generateTypesFile(tools: ExtractedSkillTool[]): string {
  const lines: string[] = [
    '// Re-exported Zod schemas for MCP tool inputs/outputs',
    '// Auto-generated by glirastes — do not edit manually.',
    '',
    "import { z } from 'zod';",
    '',
  ];

  for (const tool of tools) {
    if (tool.inputFields.length > 0) {
      const schemaName = `${camelCase(tool.toolName)}InputSchema`;
      lines.push(`export const ${schemaName} = z.object({`);
      for (const field of tool.inputFields) {
        lines.push(`  ${field.name}: ${zodTypeToCode(field)},`);
      }
      lines.push('});');
      lines.push(`export type ${pascalCase(tool.toolName)}Input = z.infer<typeof ${schemaName}>;`);
      lines.push('');
    }

    if (tool.outputFields.length > 0) {
      const schemaName = `${camelCase(tool.toolName)}OutputSchema`;
      lines.push(`export const ${schemaName} = z.object({`);
      for (const field of tool.outputFields) {
        const typeMap: Record<string, string> = {
          'string': 'z.string()',
          'number': 'z.number()',
          'boolean': 'z.boolean()',
        };
        lines.push(`  ${field.name}: ${typeMap[field.type] ?? 'z.string()'},`);
      }
      lines.push('});');
      lines.push(`export type ${pascalCase(tool.toolName)}Output = z.infer<typeof ${schemaName}>;`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate the package.json file content.
 */
function generatePackageJson(config: AgentSkillConfig): string {
  const slug = slugify(config.appName);

  const pkg = {
    name: `${slug}-mcp-server`,
    version: config.version ?? '1.0.0',
    description: `MCP server for ${config.appName}`,
    type: 'module',
    main: 'dist/server.js',
    scripts: {
      build: 'tsc',
      start: 'node dist/server.js',
      dev: 'tsx server.ts',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '^1.12.1',
      zod: '^3.24.0',
    },
    devDependencies: {
      tsx: '^4.19.0',
      typescript: '^5.7.0',
    },
  };

  return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * Generate the tsconfig.json file content.
 */
function generateTsConfig(): string {
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: './dist',
      rootDir: '.',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true,
    },
    include: ['*.ts'],
    exclude: ['node_modules', 'dist'],
  };

  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Generate the README.md file content.
 */
function generateReadme(
  config: AgentSkillConfig,
  tools: ExtractedSkillTool[],
): string {
  const slug = slugify(config.appName);

  // Group tools by module
  const byModule = new Map<string, ExtractedSkillTool[]>();
  for (const tool of tools) {
    const mod = tool.module ?? 'general';
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(tool);
  }

  const lines: string[] = [];

  lines.push(`# ${config.appName} MCP Server`);
  lines.push('');
  lines.push(`Auto-generated [Model Context Protocol](https://modelcontextprotocol.io/) server for the ${config.appName} platform API.`);
  lines.push('');
  lines.push(`**Tools:** ${tools.length} | **Modules:** ${byModule.size} | **Transport:** stdio`);
  lines.push('');

  // Setup
  lines.push('## Setup');
  lines.push('');
  lines.push('```bash');
  lines.push('npm install');
  lines.push('npm run build');
  lines.push('```');
  lines.push('');

  // Auth environment
  lines.push('## Authentication');
  lines.push('');
  lines.push(generateAuthReadmeSection(config.auth));
  lines.push('');

  // Usage with Claude Desktop
  lines.push('## Usage with Claude Desktop');
  lines.push('');
  lines.push('Add to your Claude Desktop configuration (`claude_desktop_config.json`):');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify({
    mcpServers: {
      [slug]: {
        command: 'node',
        args: ['dist/server.js'],
        cwd: `/path/to/${slug}-mcp-server`,
      },
    },
  }, null, 2));
  lines.push('```');
  lines.push('');

  // Usage with Claude Code
  lines.push('## Usage with Claude Code');
  lines.push('');
  lines.push('```bash');
  lines.push(`claude mcp add ${slug} node dist/server.js`);
  lines.push('```');
  lines.push('');

  // Available tools
  lines.push('## Available Tools');
  lines.push('');

  for (const [moduleName, moduleTools] of byModule) {
    lines.push(`### ${moduleName}`);
    lines.push('');
    lines.push('| Tool | Method | Path | Description |');
    lines.push('|------|--------|------|-------------|');
    for (const tool of moduleTools) {
      lines.push(`| \`${tool.toolName}\` | ${tool.method} | \`${tool.path}\` | ${tool.description} |`);
    }
    lines.push('');
  }

  // Development
  lines.push('## Development');
  lines.push('');
  lines.push('```bash');
  lines.push('# Run in development mode');
  lines.push('npm run dev');
  lines.push('');
  lines.push('# Build for production');
  lines.push('npm run build');
  lines.push('npm start');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate auth section for README based on auth strategy.
 */
function generateAuthReadmeSection(auth: AgentAuthStrategy): string {
  switch (auth.type) {
    case 'bearer':
      return `Set the \`${auth.tokenEnvVar}\` environment variable:\n\n\`\`\`bash\nexport ${auth.tokenEnvVar}="your-token-here"\n\`\`\``;

    case 'api-key':
      return `Set the \`${auth.keyEnvVar}\` environment variable:\n\n\`\`\`bash\nexport ${auth.keyEnvVar}="your-api-key-here"\n\`\`\``;

    case 'oauth2':
      return `Set the OAuth 2.0 credentials:\n\n\`\`\`bash\nexport ${auth.clientIdEnvVar}="your-client-id"\nexport ${auth.clientSecretEnvVar}="your-client-secret"\n\`\`\``;

    case 'cookie':
      return 'This server uses cookie-based authentication. The session cookie must be set programmatically after login.';

  }
}

// ============================================================================
// Public API
// ============================================================================

export interface GenerateMcpOptions extends GenerateOptions {
  /** Skill configuration (app name, base URL, auth) */
  skillConfig: AgentSkillConfig;
  /** Custom output directory for MCP server files (default: mcp-server/) */
  mcpOutputDir?: string;
}

export interface GenerateMcpResult {
  /** Generated files with their relative paths and content */
  files: Array<{ path: string; content: string }>;
  /** Number of MCP tools generated */
  toolCount: number;
  /** Module names that contain tools */
  modulesUsed: string[];
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
 * Generate an MCP server project from discovered tool definitions.
 *
 * Scans the project for endpoint and UI tool definitions and produces
 * a complete MCP server project as in-memory file contents. The caller
 * is responsible for writing the files to disk.
 *
 * The generated server uses stdio transport and registers one MCP tool
 * per discovered endpoint/UI tool, grouped by module.
 */
export async function generateMcpServer(
  options: GenerateMcpOptions,
): Promise<GenerateMcpResult> {
  const opts = resolveDefaults(options);
  const outputDir = options.mcpOutputDir ?? 'mcp-server';

  // Scan all tool files
  const endpointScan = await scanEndpointTools(options);
  const uiScan = await scanUiTools(options);

  // Extract tool metadata from all discovered files
  const allTools: ExtractedSkillTool[] = [];
  for (const file of [...endpointScan.files, ...uiScan.files]) {
    const tools = await extractSkillTools(file.absolutePath);
    allTools.push(...tools);
  }

  // Collect module names
  const moduleSet = new Set(allTools.map((t) => t.module ?? 'general'));
  const modulesUsed = Array.from(moduleSet).sort();

  // Generate all file contents
  const files: Array<{ path: string; content: string }> = [
    {
      path: `${outputDir}/server.ts`,
      content: generateServerFile(options.skillConfig, allTools),
    },
    {
      path: `${outputDir}/auth.ts`,
      content: generateAuthFile(options.skillConfig.auth),
    },
    {
      path: `${outputDir}/types.ts`,
      content: generateTypesFile(allTools),
    },
    {
      path: `${outputDir}/package.json`,
      content: generatePackageJson(options.skillConfig),
    },
    {
      path: `${outputDir}/tsconfig.json`,
      content: generateTsConfig(),
    },
    {
      path: `${outputDir}/README.md`,
      content: generateReadme(options.skillConfig, allTools),
    },
  ];

  if (!opts.quiet) {
    console.log(`\u2713 Generated MCP server: ${allTools.length} tools across ${modulesUsed.length} modules`);
    for (const file of files) {
      console.log(`  - ${file.path}`);
    }
  }

  return {
    files,
    toolCount: allTools.length,
    modulesUsed,
    tools: allTools,
  };
}

// ============================================================================
// String Utilities
// ============================================================================

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function camelCase(s: string): string {
  return s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}

function pascalCase(s: string): string {
  const cc = camelCase(s);
  return cc.charAt(0).toUpperCase() + cc.slice(1);
}
