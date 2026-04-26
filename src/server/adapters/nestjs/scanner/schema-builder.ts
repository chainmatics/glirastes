import { z } from 'zod';
import 'reflect-metadata';
import { getAiParamMeta, type AiParamDescription } from '../metadata.js';

/**
 * Metadata key used by @nestjs/swagger's @ApiProperty decorator.
 * Properties decorated with @ApiProperty store their options under this key.
 */
const SWAGGER_API_MODEL_PROPERTIES = 'swagger/apiModelProperties';
const SWAGGER_API_MODEL_PROPERTIES_ARRAY = 'swagger/apiModelPropertiesArray';

interface SwaggerPropertyMeta {
  description?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  type?: unknown;
  isArray?: boolean;
}

/**
 * Read @ApiProperty metadata for all properties on a DTO class.
 * Returns an array of property descriptors with description and constraints.
 */
function getSwaggerPropertyMeta(
  dtoClass: Function,
): Array<{ propertyKey: string; meta: SwaggerPropertyMeta }> {
  const propertyNames: string[] | undefined = Reflect.getMetadata(
    SWAGGER_API_MODEL_PROPERTIES_ARRAY,
    dtoClass.prototype,
  );

  if (!propertyNames || propertyNames.length === 0) return [];

  const result: Array<{ propertyKey: string; meta: SwaggerPropertyMeta }> = [];

  for (const rawKey of propertyNames) {
    // Swagger stores keys with a ':' prefix (e.g., ':name', ':description')
    const propertyKey = rawKey.startsWith(':') ? rawKey.slice(1) : rawKey;

    const meta: SwaggerPropertyMeta | undefined = Reflect.getMetadata(
      SWAGGER_API_MODEL_PROPERTIES,
      dtoClass.prototype,
      propertyKey,
    );

    if (meta) {
      result.push({ propertyKey, meta });
    }
  }

  return result;
}

// ============================================================================
// Merged param type — carries all info needed for schema + description building
// ============================================================================

interface MergedParam {
  propertyKey: string;
  description: string;
  isOptional: boolean;
  constraints: PropertyConstraints;
}

interface PropertyConstraints {
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build a Zod schema from a DTO class.
 *
 * Resolution order per property:
 * 1. @AiParam — explicit AI-specific description (highest priority)
 * 2. @ApiProperty — Swagger metadata as fallback (description, required, constraints)
 * 3. design:type — TypeScript type metadata for base type inference
 *
 * Constraints from @ApiProperty (minLength, maxLength, minimum, maximum, enum)
 * are applied as Zod validations AND appended to the property description so
 * the AI model knows the constraints before generating values.
 */
export function buildZodSchemaFromDto(
  dtoClass: Function,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const aiParams = getAiParamMeta(dtoClass);
  const swaggerProps = getSwaggerPropertyMeta(dtoClass);

  const mergedParams = buildMergedParamList(aiParams, swaggerProps);

  if (mergedParams.length === 0) return z.object({});

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of mergedParams) {
    const designType: Function | undefined = Reflect.getMetadata(
      'design:type',
      dtoClass.prototype,
      param.propertyKey,
    );

    let fieldSchema: z.ZodTypeAny = buildFieldSchema(
      designType,
      param.constraints,
    );

    // Build enriched description: base description + constraint hints
    const enrichedDescription = buildEnrichedDescription(
      param.description,
      param.constraints,
    );
    if (enrichedDescription) {
      fieldSchema = fieldSchema.describe(enrichedDescription);
    }

    // Apply optional
    if (param.isOptional) {
      fieldSchema = fieldSchema.optional();
    } else {
      fieldSchema = detectOptionalByDefault(
        dtoClass,
        param.propertyKey,
        fieldSchema,
      );
    }

    shape[param.propertyKey] = fieldSchema;
  }

  return z.object(shape);
}

/**
 * Check whether a DTO class has any AI-relevant property metadata
 * (either @AiParam or @ApiProperty decorators).
 */
export function hasAiRelevantMeta(dtoClass: Function): boolean {
  if (getAiParamMeta(dtoClass).length > 0) return true;
  if (getSwaggerPropertyMeta(dtoClass).length > 0) return true;
  return false;
}

// ============================================================================
// Internal helpers
// ============================================================================

function buildMergedParamList(
  aiParams: AiParamDescription[],
  swaggerProps: Array<{ propertyKey: string; meta: SwaggerPropertyMeta }>,
): MergedParam[] {
  const aiParamMap = new Map(aiParams.map((p) => [p.propertyKey, p]));
  const swaggerMap = new Map(
    swaggerProps.map((p) => [p.propertyKey, p.meta]),
  );

  // Collect all unique property keys (preserving order)
  const allKeys = new Set<string>();
  for (const p of aiParams) allKeys.add(p.propertyKey);
  for (const p of swaggerProps) allKeys.add(p.propertyKey);

  const result: MergedParam[] = [];

  for (const key of allKeys) {
    const aiParam = aiParamMap.get(key);
    const swaggerMeta = swaggerMap.get(key);

    const description = aiParam?.description ?? swaggerMeta?.description ?? '';
    const isOptional = swaggerMeta?.required === false;

    const constraints: PropertyConstraints = {};
    if (swaggerMeta) {
      if (swaggerMeta.minLength !== undefined)
        constraints.minLength = swaggerMeta.minLength;
      if (swaggerMeta.maxLength !== undefined)
        constraints.maxLength = swaggerMeta.maxLength;
      if (swaggerMeta.minimum !== undefined)
        constraints.minimum = swaggerMeta.minimum;
      if (swaggerMeta.maximum !== undefined)
        constraints.maximum = swaggerMeta.maximum;
      if (swaggerMeta.enum !== undefined) constraints.enum = swaggerMeta.enum;
    }

    result.push({ propertyKey: key, description, isOptional, constraints });
  }

  return result;
}

/**
 * Build a Zod field schema with constraints applied.
 */
function buildFieldSchema(
  designType: Function | undefined,
  constraints: PropertyConstraints,
): z.ZodTypeAny {
  const baseSchema = designTypeToZod(designType);

  // Apply constraints based on the Zod type
  if (baseSchema instanceof z.ZodString) {
    return applyStringConstraints(baseSchema, constraints);
  }
  if (baseSchema instanceof z.ZodNumber) {
    return applyNumberConstraints(baseSchema, constraints);
  }
  if (constraints.enum && constraints.enum.length > 0) {
    return buildEnumSchema(constraints.enum);
  }

  return baseSchema;
}

function applyStringConstraints(
  schema: z.ZodString,
  constraints: PropertyConstraints,
): z.ZodTypeAny {
  let s = schema;
  if (constraints.minLength !== undefined) s = s.min(constraints.minLength);
  if (constraints.maxLength !== undefined) s = s.max(constraints.maxLength);

  // Enum overrides string type entirely
  if (constraints.enum && constraints.enum.length > 0) {
    return buildEnumSchema(constraints.enum);
  }

  return s;
}

function applyNumberConstraints(
  schema: z.ZodNumber,
  constraints: PropertyConstraints,
): z.ZodNumber {
  let n = schema;
  if (constraints.minimum !== undefined) n = n.min(constraints.minimum);
  if (constraints.maximum !== undefined) n = n.max(constraints.maximum);
  return n;
}

function buildEnumSchema(values: unknown[]): z.ZodTypeAny {
  const stringValues = values.filter(
    (v): v is string => typeof v === 'string',
  );
  if (stringValues.length >= 2) {
    return z.enum(stringValues as [string, string, ...string[]]);
  }
  if (stringValues.length === 1) {
    return z.literal(stringValues[0]);
  }
  return z.unknown();
}

/**
 * Append constraint hints to the base description so the AI model
 * knows the validation rules before generating values.
 */
function buildEnrichedDescription(
  baseDescription: string,
  constraints: PropertyConstraints,
): string {
  const hints: string[] = [];

  if (constraints.minLength !== undefined && constraints.maxLength !== undefined) {
    hints.push(`${constraints.minLength}-${constraints.maxLength} characters`);
  } else if (constraints.minLength !== undefined) {
    hints.push(`min ${constraints.minLength} characters`);
  } else if (constraints.maxLength !== undefined) {
    hints.push(`max ${constraints.maxLength} characters`);
  }

  if (constraints.minimum !== undefined && constraints.maximum !== undefined) {
    hints.push(`range ${constraints.minimum}-${constraints.maximum}`);
  } else if (constraints.minimum !== undefined) {
    hints.push(`min ${constraints.minimum}`);
  } else if (constraints.maximum !== undefined) {
    hints.push(`max ${constraints.maximum}`);
  }

  if (constraints.enum && constraints.enum.length > 0) {
    const values = constraints.enum
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map((v) => String(v));
    if (values.length > 0) {
      hints.push(`one of: ${values.join(', ')}`);
    }
  }

  if (hints.length === 0) return baseDescription;

  const constraintSuffix = `(${hints.join('; ')})`;
  return baseDescription
    ? `${baseDescription} ${constraintSuffix}`
    : constraintSuffix;
}

function designTypeToZod(designType: Function | undefined): z.ZodTypeAny {
  if (!designType) return z.unknown();
  switch (designType) {
    case String:
      return z.string();
    case Number:
      return z.number();
    case Boolean:
      return z.boolean();
    case Array:
      return z.array(z.unknown());
    case Date:
      return z.string();
    default:
      return z.unknown();
  }
}

/**
 * Extract @Param() parameter names from a controller method's route arguments metadata.
 * NestJS stores route arguments under '__routeArguments__' with keys like "5:0" where
 * 5 = RouteParamtypes.PARAM. The `data` field holds the parameter name (e.g., 'id').
 */
export function extractRouteParams(
  controllerClass: Function,
  methodName: string,
): string[] {
  const ROUTE_ARGS_METADATA = '__routeArguments__';
  const PARAM_TYPE = '5'; // RouteParamtypes.PARAM

  const routeArgs: Record<string, { index: number; data?: string }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controllerClass, methodName) ?? {};

  const params: string[] = [];
  for (const [key, value] of Object.entries(routeArgs)) {
    if (key.startsWith(`${PARAM_TYPE}:`) && value.data) {
      params.push(value.data);
    }
  }
  return params;
}

/**
 * Check if a property has a default value on a constructed instance.
 * If so, mark it as optional.
 */
function detectOptionalByDefault(
  dtoClass: Function,
  propertyKey: string,
  fieldSchema: z.ZodTypeAny,
): z.ZodTypeAny {
  try {
    const constructed = new (dtoClass as new () => unknown)();
    if (
      constructed &&
      typeof constructed === 'object' &&
      propertyKey in (constructed as Record<string, unknown>)
    ) {
      return fieldSchema.optional();
    }
  } catch {
    // Cannot construct, skip optional detection
  }
  return fieldSchema;
}
