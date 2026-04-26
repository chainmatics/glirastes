import { readFile, writeFile } from 'node:fs/promises';
import type { EndpointMethod, OpenApiAiExtension } from '../types.js';

const SUPPORTED_METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
const MUTATING_METHODS = new Set<SupportedMethod>(['post', 'patch', 'put', 'delete']);

type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

type ParameterLocation = 'path' | 'query' | 'header' | 'cookie';

interface OpenApiReference {
  $ref: string;
}

interface OpenApiSchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: OpenApiSchema | OpenApiReference;
  properties?: Record<string, OpenApiSchema | OpenApiReference>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema | OpenApiReference;
}

interface OpenApiMediaType {
  schema?: OpenApiSchema | OpenApiReference;
}

interface OpenApiRequestBody {
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

interface OpenApiParameter {
  name: string;
  in: ParameterLocation;
  required?: boolean;
  schema?: OpenApiSchema | OpenApiReference;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<OpenApiParameter | OpenApiReference>;
  requestBody?: OpenApiRequestBody | OpenApiReference;
  'x-ai'?: OpenApiAiExtension;
}

interface OpenApiPathItem {
  parameters?: Array<OpenApiParameter | OpenApiReference>;
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  patch?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema>;
  parameters?: Record<string, OpenApiParameter>;
  requestBodies?: Record<string, OpenApiRequestBody>;
}

interface OpenApiDocument {
  paths?: Record<string, OpenApiPathItem>;
  components?: OpenApiComponents;
}

interface OperationContext {
  path: string;
  method: SupportedMethod;
  operation: OpenApiOperation;
  pathItem: OpenApiPathItem;
}

interface InputField {
  name: string;
  zodCode: string;
  required: boolean;
  source: ParameterLocation | 'body';
}

interface ValidationResult {
  enabledTools: number;
  errors: string[];
  warnings: string[];
}

export interface GeneratedToolSpec {
  id: string;
  toolName: string;
  description: string;
  method: EndpointMethod;
  path: string;
  needsApproval: boolean;
  inputSchemaCode: string;
  uiActionOnSuccess?: Record<string, unknown> | Record<string, unknown>[];
}

function isRef(value: unknown): value is OpenApiReference {
  return typeof value === 'object' && value !== null && '$ref' in value;
}

function toMethod(value: SupportedMethod): EndpointMethod {
  return value.toUpperCase() as EndpointMethod;
}

function normalizePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

function normalizeToolName(value: string): string {
  return value.trim();
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderObject(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent);
}

function renderObjectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${escapeString(key)}'`;
}

function readRef(document: OpenApiDocument, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local refs are supported in this prototype: ${ref}`);
  }

  const segments = ref.slice(2).split('/');
  let current: unknown = document;

  for (const rawSegment of segments) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');

    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new Error(`Cannot resolve ref: ${ref}`);
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function resolveSchema(
  document: OpenApiDocument,
  schema: OpenApiSchema | OpenApiReference | undefined,
  seenRefs = new Set<string>()
): OpenApiSchema | undefined {
  if (!schema) return undefined;
  if (!isRef(schema)) return schema;

  const ref = schema.$ref;
  if (seenRefs.has(ref)) {
    return { type: 'object' };
  }

  seenRefs.add(ref);
  const resolved = readRef(document, ref);

  if (typeof resolved !== 'object' || resolved === null) {
    throw new Error(`Ref does not point to an object schema: ${ref}`);
  }

  return resolveSchema(document, resolved as OpenApiSchema | OpenApiReference, seenRefs);
}

function resolveParameter(
  document: OpenApiDocument,
  parameter: OpenApiParameter | OpenApiReference
): OpenApiParameter {
  if (!isRef(parameter)) return parameter;

  const resolved = readRef(document, parameter.$ref);
  if (!resolved || typeof resolved !== 'object') {
    throw new Error(`Invalid parameter ref: ${parameter.$ref}`);
  }

  return resolved as OpenApiParameter;
}

function resolveRequestBody(
  document: OpenApiDocument,
  requestBody: OpenApiRequestBody | OpenApiReference | undefined
): OpenApiRequestBody | undefined {
  if (!requestBody) return undefined;
  if (!isRef(requestBody)) return requestBody;

  const resolved = readRef(document, requestBody.$ref);
  if (!resolved || typeof resolved !== 'object') {
    throw new Error(`Invalid requestBody ref: ${requestBody.$ref}`);
  }

  return resolved as OpenApiRequestBody;
}

function collectOperations(document: OpenApiDocument): OperationContext[] {
  const operations: OperationContext[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of SUPPORTED_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      operations.push({ path, method, operation, pathItem });
    }
  }

  return operations;
}

function getMergedParameters(document: OpenApiDocument, context: OperationContext): OpenApiParameter[] {
  const merged = new Map<string, OpenApiParameter>();

  const pathLevel = context.pathItem.parameters ?? [];
  const operationLevel = context.operation.parameters ?? [];

  for (const param of pathLevel) {
    const resolved = resolveParameter(document, param);
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }

  for (const param of operationLevel) {
    const resolved = resolveParameter(document, param);
    merged.set(`${resolved.in}:${resolved.name}`, resolved);
  }

  return Array.from(merged.values());
}

function listPathParams(path: string): string[] {
  return Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1]);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
}

function schemaToZodCode(
  document: OpenApiDocument,
  schema: OpenApiSchema | OpenApiReference | undefined
): string {
  const resolved = resolveSchema(document, schema);
  if (!resolved) return 'z.unknown()';

  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    if (resolved.enum.every((item) => typeof item === 'string')) {
      return `z.enum(${renderObject(resolved.enum)})`;
    }

    const literals = resolved.enum
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map((item) => `z.literal(${JSON.stringify(item)})`);

    if (literals.length > 0) {
      return `z.union([${literals.join(', ')}])`;
    }
  }

  if (resolved.type === 'string') {
    if (resolved.format === 'uuid') return 'z.string().uuid()';
    return 'z.string()';
  }

  if (resolved.type === 'integer' || resolved.type === 'number') {
    return 'z.number()';
  }

  if (resolved.type === 'boolean') {
    return 'z.boolean()';
  }

  if (resolved.type === 'array') {
    return `z.array(${schemaToZodCode(document, resolved.items)})`;
  }

  if (resolved.type === 'object' || resolved.properties || resolved.additionalProperties) {
    const properties = resolved.properties ?? {};
    const required = new Set(resolved.required ?? []);

    const entries = Object.entries(properties).map(([name, childSchema]) => {
      const base = schemaToZodCode(document, childSchema);
      const code = required.has(name) ? base : `${base}.optional()`;
      return `${renderObjectKey(name)}: ${code}`;
    });

    const objectCode = `z.object({${entries.length > 0 ? `\n      ${entries.join(',\n      ')}\n    ` : ''}})`;

    if (resolved.additionalProperties) {
      return `${objectCode}.passthrough()`;
    }

    return objectCode;
  }

  return 'z.unknown()';
}

function addOrMergeField(fields: Map<string, InputField>, candidate: InputField): void {
  const existing = fields.get(candidate.name);

  if (!existing) {
    fields.set(candidate.name, candidate);
    return;
  }

  const mergedRequired = existing.required || candidate.required;
  const mergedCode = existing.zodCode === candidate.zodCode ? existing.zodCode : 'z.unknown()';

  fields.set(candidate.name, {
    ...existing,
    required: mergedRequired,
    zodCode: mergedCode,
  });
}

function createInputSchemaCode(document: OpenApiDocument, context: OperationContext): string {
  const fields = new Map<string, InputField>();
  const mergedParameters = getMergedParameters(document, context);

  for (const parameter of mergedParameters) {
    const required = parameter.in === 'path' ? true : Boolean(parameter.required);
    addOrMergeField(fields, {
      name: parameter.name,
      zodCode: schemaToZodCode(document, parameter.schema),
      required,
      source: parameter.in,
    });
  }

  const requestBody = resolveRequestBody(document, context.operation.requestBody);
  const jsonSchema = requestBody?.content?.['application/json']?.schema;
  const resolvedBodySchema = resolveSchema(document, jsonSchema);

  if (resolvedBodySchema) {
    if (resolvedBodySchema.type === 'object' || resolvedBodySchema.properties) {
      const required = new Set(resolvedBodySchema.required ?? []);

      for (const [name, child] of Object.entries(resolvedBodySchema.properties ?? {})) {
        addOrMergeField(fields, {
          name,
          zodCode: schemaToZodCode(document, child),
          required: required.has(name),
          source: 'body',
        });
      }
    } else {
      addOrMergeField(fields, {
        name: 'body',
        zodCode: schemaToZodCode(document, resolvedBodySchema),
        required: Boolean(requestBody?.required),
        source: 'body',
      });
    }
  }

  const sorted = Array.from(fields.values()).sort((a, b) => a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    return 'z.object({}).passthrough()';
  }

  const entries = sorted.map((field) => {
    const code = field.required ? field.zodCode : `${field.zodCode}.optional()`;
    return `${renderObjectKey(field.name)}: ${code}`;
  });

  return `z.object({\n      ${entries.join(',\n      ')}\n    })`;
}

function formatValidationMessage(kind: 'error' | 'warning', message: string): string {
  const marker = kind === 'error' ? 'ERROR' : 'WARN';
  return `[${marker}] ${message}`;
}

export function validateOpenApiDocument(document: OpenApiDocument): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const operationIds = new Map<string, string>();
  const toolNames = new Map<string, string>();
  let enabledTools = 0;

  for (const context of collectOperations(document)) {
    const pointer = `${context.method.toUpperCase()} ${context.path}`;
    const operationId = context.operation.operationId;

    if (operationId) {
      const seenAt = operationIds.get(operationId);
      if (seenAt) {
        errors.push(formatValidationMessage('error', `Duplicate operationId "${operationId}" at ${pointer}. First seen at ${seenAt}.`));
      } else {
        operationIds.set(operationId, pointer);
      }
    }

    const ai = context.operation['x-ai'];
    if (!ai?.enabled) continue;
    enabledTools += 1;

    if (!operationId) {
      errors.push(formatValidationMessage('error', `Missing operationId for enabled tool at ${pointer}.`));
    }

    const toolName = ai.toolName ? normalizeToolName(ai.toolName) : '';
    if (!toolName) {
      errors.push(formatValidationMessage('error', `Missing x-ai.toolName for ${pointer}.`));
    } else {
      const seenAt = toolNames.get(toolName);
      if (seenAt) {
        errors.push(formatValidationMessage('error', `Duplicate x-ai.toolName "${toolName}" at ${pointer}. First seen at ${seenAt}.`));
      } else {
        toolNames.set(toolName, pointer);
      }

      if (!/^[a-z0-9_]+$/.test(toolName)) {
        warnings.push(formatValidationMessage('warning', `Tool name "${toolName}" at ${pointer} should match ^[a-z0-9_]+$ for model/tooling consistency.`));
      }
    }

    if (MUTATING_METHODS.has(context.method) && ai.needsApproval === false) {
      errors.push(formatValidationMessage('error', `Mutating endpoint ${pointer} cannot set x-ai.needsApproval to false.`));
    }

    const params = getMergedParameters(document, context);
    const pathParams = new Set(params.filter((param) => param.in === 'path').map((param) => param.name));

    for (const pathParam of listPathParams(context.path)) {
      if (!pathParams.has(pathParam)) {
        errors.push(formatValidationMessage('error', `Path parameter "${pathParam}" in ${pointer} is missing from OpenAPI parameters.`));
      }
    }

    if (!ai.description && !context.operation.summary && !context.operation.description) {
      warnings.push(formatValidationMessage('warning', `No description found for enabled tool at ${pointer}. Add x-ai.description or summary.`));
    }
  }

  return {
    enabledTools,
    errors,
    warnings,
  };
}

export function extractGeneratedToolSpecs(document: OpenApiDocument): GeneratedToolSpec[] {
  const tools: GeneratedToolSpec[] = [];

  for (const context of collectOperations(document)) {
    const ai = context.operation['x-ai'];
    if (!ai?.enabled) continue;

    if (!context.operation.operationId) {
      throw new Error(`Missing operationId for ${context.method.toUpperCase()} ${context.path}`);
    }

    const toolName = ai.toolName ? normalizeToolName(ai.toolName) : '';
    if (!toolName) {
      throw new Error(`Missing x-ai.toolName for ${context.operation.operationId}`);
    }

    const description =
      ai.description ??
      context.operation.summary ??
      context.operation.description ??
      `${context.method.toUpperCase()} ${context.path}`;

    tools.push({
      id: context.operation.operationId,
      toolName,
      description,
      method: toMethod(context.method),
      path: normalizePath(context.path),
      inputSchemaCode: createInputSchemaCode(document, context),
      needsApproval: ai.needsApproval ?? MUTATING_METHODS.has(context.method),
      uiActionOnSuccess: ai.uiActionOnSuccess,
    });
  }

  tools.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return tools;
}

export function renderTypeScriptFromSpecs(specs: GeneratedToolSpec[]): string {
  const header = `/* eslint-disable */\n/**\n * AUTO-GENERATED FILE.\n * Generated from OpenAPI + x-ai metadata.\n */\n\n`;

  if (specs.length === 0) {
    return `${header}import { z } from 'zod';\nimport { defineEndpointTool } from 'glirastes';\n\nexport const generatedEndpointTools = [] as const;\n`;
  }

  const bodies = specs
    .map((spec) => {
      const uiActionLine = spec.uiActionOnSuccess
        ? `\n    uiActionOnSuccess: ${renderObject(spec.uiActionOnSuccess, 4)},`
        : '';

      return `  defineEndpointTool({\n    id: '${escapeString(spec.id)}',\n    toolName: '${escapeString(spec.toolName)}',\n    description: '${escapeString(spec.description)}',\n    method: '${spec.method}',\n    path: '${escapeString(spec.path)}',\n    inputSchema: ${spec.inputSchemaCode},\n    needsApproval: ${spec.needsApproval},${uiActionLine}\n  })`;
    })
    .join(',\n\n');

  return `${header}import { z } from 'zod';\nimport { defineEndpointTool } from 'glirastes';\n\nexport const generatedEndpointTools = [\n${bodies}\n] as const;\n`;
}

export async function validateOpenApiFile(options: { inputPath: string }): Promise<ValidationResult> {
  const raw = await readFile(options.inputPath, 'utf8');
  const document = JSON.parse(raw) as OpenApiDocument;
  return validateOpenApiDocument(document);
}

export async function generateFromOpenApiFile(options: {
  inputPath: string;
  outputPath: string;
}): Promise<ValidationResult> {
  const raw = await readFile(options.inputPath, 'utf8');
  const document = JSON.parse(raw) as OpenApiDocument;

  const validation = validateOpenApiDocument(document);
  if (validation.errors.length > 0) {
    throw new Error(`OpenAPI validation failed:\n${validation.errors.join('\n')}`);
  }

  const specs = extractGeneratedToolSpecs(document);
  const output = renderTypeScriptFromSpecs(specs);
  await writeFile(options.outputPath, output, 'utf8');

  return validation;
}
