import type { EndpointMethod, OpenApiAiExtension } from '../types.js';
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
    /** Which roles can use this tool. If not specified, all roles have access. */
    allowedRoles?: string[];
    needsApproval: boolean;
    inputSchemaCode: string;
    uiActionOnSuccess?: Record<string, unknown>;
}
export declare function validateOpenApiDocument(document: OpenApiDocument): ValidationResult;
export declare function extractGeneratedToolSpecs(document: OpenApiDocument): GeneratedToolSpec[];
export declare function renderTypeScriptFromSpecs(specs: GeneratedToolSpec[]): string;
export declare function validateOpenApiFile(options: {
    inputPath: string;
}): Promise<ValidationResult>;
export declare function generateFromOpenApiFile(options: {
    inputPath: string;
    outputPath: string;
}): Promise<ValidationResult>;
export {};
