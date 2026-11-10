import ts from 'typescript';
import { canonicalJson, compareCodeUnits } from './canonical.js';
import type { JsonSchemaLike } from './types.js';

export const MAX_OUTPUT_DEPTH = 6;
const MAX_PROPERTIES = 200;

function isOpaque(schema: JsonSchemaLike): boolean {
  return Object.keys(schema).length === 0;
}

function dedupe(schemas: ReadonlyArray<JsonSchemaLike>): JsonSchemaLike[] {
  const byText = new Map<string, JsonSchemaLike>();
  for (const schema of schemas) byText.set(canonicalJson(schema), schema);
  return [...byText.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, schema]) => schema);
}

/** Bounded checker-type → JSON Schema; anything not provable becomes `{}`. */
export function typeToJsonSchema(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  depth = 0,
  seen: ReadonlySet<ts.Type> = new Set(),
): JsonSchemaLike {
  if (depth > MAX_OUTPUT_DEPTH) return {};
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return {};
  if (flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [(type as ts.StringLiteralType).value] };
  if (flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [(type as ts.NumberLiteralType).value] };
  if (flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean' };
  if (flags & ts.TypeFlags.StringLike) return { type: 'string' };
  if (flags & ts.TypeFlags.NumberLike) return { type: 'number' };
  if (flags & ts.TypeFlags.BooleanLike) return { type: 'boolean' };
  if (flags & ts.TypeFlags.Null) return { type: 'null' };
  if (type.isUnion()) {
    const members = type.types.filter((member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
    if (members.length > 0 && members.every((member) => member.flags & ts.TypeFlags.StringLiteral)) {
      return {
        type: 'string',
        enum: members.map((member) => (member as ts.StringLiteralType).value).sort(compareCodeUnits),
      };
    }
    if (members.length > 0 && members.every((member) => member.flags & ts.TypeFlags.BooleanLiteral)) {
      return { type: 'boolean' };
    }
    const parts = dedupe(members.map((member) => typeToJsonSchema(checker, member, location, depth + 1, seen)));
    if (parts.length === 0 || parts.some(isOpaque)) return {};
    return parts.length === 1 ? parts[0]! : { anyOf: parts };
  }
  if (seen.has(type)) return {};
  if (checker.isArrayType(type)) {
    const [element] = checker.getTypeArguments(type as ts.TypeReference);
    return { type: 'array', items: element ? typeToJsonSchema(checker, element, location, depth + 1, seen) : {} };
  }
  if (checker.isTupleType(type)) return { type: 'array' };
  if (type.symbol?.name === 'Date') return { type: 'string', format: 'date-time' };
  if (flags & ts.TypeFlags.Object) {
    if (type.getCallSignatures().length > 0) return {};
    if (checker.getIndexInfosOfType(type).length > 0) return { type: 'object' };
    const properties = checker.getPropertiesOfType(type)
      .filter((property) => !(property.flags & ts.SymbolFlags.Method));
    if (properties.length > MAX_PROPERTIES) return { type: 'object' };
    const next = new Set(seen).add(type);
    const entries = properties
      .map((property) => [
        property.name,
        typeToJsonSchema(checker, checker.getTypeOfSymbolAtLocation(property, location), location, depth + 1, next),
      ] as const)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    const required = properties
      .filter((property) => !(property.flags & ts.SymbolFlags.Optional))
      .map((property) => property.name)
      .sort(compareCodeUnits);
    return {
      type: 'object',
      properties: Object.fromEntries(entries),
      ...(required.length ? { required } : {}),
    };
  }
  return {};
}

export function inferResponseSchema(
  checker: ts.TypeChecker,
  expressions: ReadonlyArray<ts.Expression>,
): JsonSchemaLike | undefined {
  if (expressions.length === 0) return undefined;
  const schemas = dedupe(expressions.map((expression) => (
    typeToJsonSchema(checker, checker.getTypeAtLocation(expression), expression)
  )));
  if (schemas.some(isOpaque)) return undefined;
  return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}
