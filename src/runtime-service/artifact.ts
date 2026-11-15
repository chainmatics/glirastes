import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  LocalPromptBundleSchema,
  type LocalPromptBundle,
} from "../cli/commands/validate-build.js";
import { AppSetupArtifactSchema } from "../contracts/index.js";
import {
  ToolReportFileSchema,
  promptMetadata,
  type ToolReportFile,
} from "../codegen/tools/artifact.js";
import { canonicalJson } from "../codegen/tools/canonical.js";
import {
  loadToolsConfig,
  normalizeSources,
  TOOLS_PATHS,
} from "../codegen/tools/config.js";
import { findExclusion } from "../codegen/tools/exclusions.js";
import { ToolContractsFileSchema } from "../codegen/tools/files.js";
import { readToolInputs } from "../codegen/tools/inputs.js";
import { runToolsPipeline } from "../codegen/tools/pipeline.js";
import {
  dereference,
  operationsOf,
  parseOpenapiDocument,
  OPENAPI_DOCUMENT_LIMIT,
  OPENAPI_TOOL_METHODS,
} from "../codegen/openapi-document.js";
import {
  createContractBindings,
  type GeneratedToolBinding,
} from "../runtime/contract-bindings.js";
import type { GlirastesGeneratedModule } from "../runtime/glirastes.js";
import { createJsonSchemaLike } from "../runtime/json-schema.js";
import { modelFacingToolName } from "../runtime/local-tool-bindings.js";
import { SDK_VERSION } from "../runtime/sdk-version.js";
import {
  endpointToolToTool,
  uiActionToolToTool,
} from "../server/core/index.js";

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sdkVersion: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const PayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    setupArtifact: AppSetupArtifactSchema,
    contracts: ToolContractsFileSchema,
    promptBundle: LocalPromptBundleSchema,
    coverage: ToolReportFileSchema,
  })
  .strict();
export type RuntimeArtifactManifest = z.infer<typeof ManifestSchema>;
export interface LoadedRuntimeArtifact extends GlirastesGeneratedModule {
  readonly promptBundle: LocalPromptBundle;
  readonly coverage: ToolReportFile;
  readonly manifest: RuntimeArtifactManifest;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function boundedFile(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes)
    throw new Error("Runtime artifact file must be a bounded regular file");
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data) > maxBytes)
    throw new Error("Runtime artifact file is too large");
  return data;
}

/** The container supports only representations the existing HTTP caller actually sends. */
async function checkOpenapiSubset(projectRoot: string): Promise<void> {
  const config = loadToolsConfig(projectRoot);
  const { inputs, findings } = await readToolInputs(projectRoot, config);
  if (findings.some((finding) => finding.severity === "error"))
    throw new Error("Invalid runtime artifact inputs");
  const errors: string[] = [];
  for (const source of normalizeSources(config)) {
    if (source.kind !== "openapi") {
      if (["next-app", "nest"].includes(source.kind))
        errors.push(`${source.kind}: container endpoints must use OpenAPI`);
      continue;
    }
    const documentPath = await realpath(
      resolve(projectRoot, source.document ?? "openapi.json"),
    );
    const relativePath = relative(await realpath(projectRoot), documentPath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..")
      throw new Error("OpenAPI document escapes project root");
    const parsed = parseOpenapiDocument(
      await boundedFile(documentPath, OPENAPI_DOCUMENT_LIMIT),
    );
    if (!parsed.ok) throw new Error(`OpenAPI unsupported: ${parsed.reason}`);
    const document = parsed.document;
    for (const [path, item] of Object.entries(document.paths)) {
      if (object(item) && item.$ref !== undefined)
        errors.push(`${path}: path-item references are unsupported`);
    }
    for (const entry of operationsOf(document)) {
      const method = OPENAPI_TOOL_METHODS[entry.operationKey];
      const path = entry.path ?? entry.documentPath;
      const stableKey = `${entry.operationKey.toUpperCase()} ${path}`;
      if (
        findExclusion(
          {
            stableKey,
            method: entry.operationKey.toUpperCase(),
            path,
            chatHandler: false,
            aiIgnore: entry.operation["x-glirastes-ignore"] === true,
          },
          inputs.policy.exclude ?? [],
        )
      )
        continue;
      const fail = (reason: string) => errors.push(`${stableKey}: ${reason}`);
      if (!method || entry.path === undefined) {
        fail("unsupported method or path");
        continue;
      }
      if (entry.pathItem.$ref) fail("path-item references are unsupported");
      const resolved = dereference(document, {
        operation: entry.operation,
        parameters: entry.pathItem.parameters ?? [],
      });
      if (resolved.problems.length) fail("unresolved schema reference");
      const data = resolved.value as {
        operation: Record<string, unknown>;
        parameters: unknown[];
      };
      const op = data.operation;
      // Runtime validators use Ajv's draft-07 evaluator. Do not silently ignore
      // newer validation keywords from an otherwise valid OpenAPI 3.1 schema.
      const unsupportedSchemaKeys = new Set([
        "unevaluatedProperties",
        "unevaluatedItems",
        "prefixItems",
        "dependentRequired",
        "dependentSchemas",
        "minContains",
        "maxContains",
        "$dynamicRef",
        "$dynamicAnchor",
        "$recursiveRef",
      ]);
      const inspectSchema = (schema: unknown): void => {
        if (!object(schema)) return;
        for (const key of Object.keys(schema))
          if (unsupportedSchemaKeys.has(key))
            fail(`unsupported JSON Schema keyword ${key}`);
        for (const key of [
          "properties",
          "patternProperties",
          "$defs",
          "definitions",
          "dependencies",
        ]) {
          if (object(schema[key]))
            Object.values(schema[key]).forEach(inspectSchema);
        }
        for (const key of [
          "items",
          "additionalItems",
          "additionalProperties",
          "contains",
          "not",
          "if",
          "then",
          "else",
        ]) {
          const child = schema[key];
          if (Array.isArray(child)) child.forEach(inspectSchema);
          else inspectSchema(child);
        }
        for (const key of ["anyOf", "oneOf", "allOf"])
          if (Array.isArray(schema[key])) schema[key].forEach(inspectSchema);
      };
      const inspectSchemas = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(inspectSchemas);
          return;
        }
        if (!object(node)) return;
        for (const [key, value] of Object.entries(node)) {
          if (key === "schema") inspectSchema(value);
          else if (!["example", "examples"].includes(key))
            inspectSchemas(value);
        }
      };
      inspectSchemas(data);
      const parameters = [
        ...(Array.isArray(data.parameters) ? data.parameters : []),
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const names = new Map<string, string>();
      for (const parameter of parameters) {
        if (!object(parameter)) {
          fail("invalid parameter");
          continue;
        }
        const location = parameter.in;
        const schema = object(parameter.schema) ? parameter.schema : {};
        if (location === "header" || location === "cookie") {
          // Credentials come from the trusted resolver, not model arguments. Optional custom headers are not supported either.
          fail(
            "header and cookie parameters are unsupported; declare authentication via securitySchemes",
          );
          continue;
        }
        if (location !== "path" && location !== "query") {
          fail("unsupported parameter location");
          continue;
        }
        if (parameter.content || parameter.allowReserved === true)
          fail("unsupported parameter serialization");
        const expectedStyle = location === "query" ? "form" : "simple";
        if (parameter.style !== undefined && parameter.style !== expectedStyle)
          fail("unsupported parameter style");
        if (location === "query" && parameter.explode === false)
          fail("unsupported query explode=false");
        if (location === "query" && !["GET", "HEAD", "DELETE"].includes(method))
          fail("query parameters on body methods are unsupported");
        const type = schema.type;
        if (
          !["string", "number", "integer", "boolean", "array"].includes(
            String(type),
          ) ||
          (location === "path" && type === "array")
        )
          fail("structured parameter is unsupported");
        if (
          type === "array" &&
          (!object(schema.items) ||
            !["string", "number", "integer", "boolean"].includes(
              String(schema.items.type),
            ))
        )
          fail("structured array parameter is unsupported");
        if (
          schema.anyOf ||
          schema.oneOf ||
          schema.allOf ||
          schema.$ref ||
          type === undefined ||
          Array.isArray(type)
        )
          fail("parameter must have an explicit scalar or scalar-array type");
        const name = String(parameter.name);
        if (names.has(name) && names.get(name) !== location)
          fail("parameter names overlap across locations");
        names.set(name, String(location));
      }
      if (op.requestBody !== undefined) {
        const content =
          object(op.requestBody) && object(op.requestBody.content)
            ? op.requestBody.content
            : {};
        const json = content["application/json"];
        if (["GET", "HEAD", "DELETE"].includes(method) || !object(json))
          fail("unsupported request body");
        else {
          const schema = object(json.schema) ? json.schema : {};
          if (
            schema.type !== "object" ||
            schema.anyOf ||
            schema.oneOf ||
            schema.allOf
          )
            fail("request body must be a JSON object");
          if (
            object(op.requestBody) &&
            op.requestBody.required === true &&
            (!Array.isArray(schema.required) || schema.required.length === 0)
          )
            fail(
              "required body may be empty; this representation is unsupported",
            );
          const properties = object(schema.properties) ? schema.properties : {};
          if (Object.keys(properties).some((name) => names.has(name)))
            fail("body and parameter names overlap");
        }
      }
    }
  }
  if (errors.length)
    throw new Error(
      `Runtime artifact unsupported operations:\n${errors.join("\n")}`,
    );
}

/** Builds with the SDK generator; frozen mode is the deployment/CI freshness gate. Output must be a new directory. */
export async function buildRuntimeArtifact(options: {
  projectRoot: string;
  outputDirectory: string;
  mode?: "write" | "frozen";
}): Promise<{ manifest: RuntimeArtifactManifest; coverage: ToolReportFile }> {
  const projectRoot = resolve(options.projectRoot);
  await checkOpenapiSubset(projectRoot);
  const result = await runToolsPipeline({
    root: projectRoot,
    mode: options.mode ?? "write",
  });
  const coverage = ToolReportFileSchema.parse(
    JSON.parse(result.outputs[TOOLS_PATHS.report]),
  );
  const blocking = coverage.findings.filter(
    (finding) =>
      finding.severity === "error" ||
      finding.severity === "needs_attention" ||
      finding.code === "schema-reference-unresolved",
  );
  if (blocking.length)
    throw new Error(
      `Runtime artifact unsupported contracts: ${blocking.map((finding) => `${finding.subjectRef}: ${finding.code}`).join(", ")}`,
    );
  const payload = PayloadSchema.parse({
    schemaVersion: 1,
    setupArtifact: JSON.parse(result.outputs[TOOLS_PATHS.setupArtifact]),
    contracts: JSON.parse(result.outputs[TOOLS_PATHS.contracts]),
    coverage,
    promptBundle: JSON.parse(
      await boundedFile(
        resolve(projectRoot, TOOLS_PATHS.promptBundle),
        MAX_ARTIFACT_BYTES,
      ),
    ),
  });
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES)
    throw new Error("Runtime artifact is too large");
  const manifest: RuntimeArtifactManifest = {
    schemaVersion: 1,
    sdkVersion: SDK_VERSION,
    sha256: hash(text),
  };
  materialize(payload, manifest); // Validate every binding before publishing anything.
  const output = resolve(options.outputDirectory);
  try {
    await lstat(output);
    throw new Error(
      "Runtime artifact output already exists; use a new versioned directory",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(resolve(dirname(output), ".runtime-artifact-"));
  try {
    await writeFile(resolve(staging, "runtime.json"), text);
    await writeFile(
      resolve(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await writeFile(
      resolve(staging, "coverage.json"),
      JSON.stringify(coverage, null, 2) + "\n",
    );
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { manifest, coverage };
}

function materialize(
  payload: z.infer<typeof PayloadSchema>,
  manifest: RuntimeArtifactManifest,
): LoadedRuntimeArtifact {
  const { setupArtifact, contracts, promptBundle, coverage } = payload;
  if (
    contracts.appId !== setupArtifact.appId ||
    promptBundle.appId !== setupArtifact.appId ||
    coverage.appId !== setupArtifact.appId
  )
    throw new Error("Runtime artifact app identity mismatch");
  if (
    canonicalJson(promptMetadata(promptBundle)) !==
    canonicalJson(setupArtifact.prompts)
  )
    throw new Error("Runtime artifact prompt integrity mismatch");
  const byId = new Map(contracts.tools.map((entry) => [entry.toolId, entry]));
  const tools = setupArtifact.tools
    .filter((tool) => tool.enabled)
    .sort((a, b) => a.toolId.localeCompare(b.toolId));
  const bindings: GeneratedToolBinding[] = tools.map((tool) => {
    const contract = byId.get(tool.toolId)?.contract;
    if (
      !contract ||
      contract.runtime.input.kind !== "json" ||
      contract.runtime.output.kind !== "json"
    )
      throw new Error(
        `Runtime artifact unsupported executable schema: ${tool.toolId}`,
      );
    const inputSchema = createJsonSchemaLike(contract.runtime.input.schema);
    const outputSchema = createJsonSchemaLike(contract.runtime.output.schema);
    const common = {
      toolId: tool.toolId,
      definitionId: tool.name,
      modelName: tool.modelName ?? modelFacingToolName(tool.name),
      description: tool.description ?? tool.name,
      riskClass: tool.riskClass,
      requiresApproval: tool.requiresApproval,
      sourceFingerprint: tool.sourceFingerprint,
      inputSchemaDigest: tool.inputSchemaDigest,
      outputSchemaDigest: tool.outputSchemaDigest,
      inputSchema,
      outputSchema,
    };
    const definition = {
      id: tool.name,
      toolName: tool.modelName ?? modelFacingToolName(tool.name),
      description: tool.description ?? tool.name,
      inputSchema,
      needsApproval: tool.requiresApproval,
    };
    if (tool.executionKind === "endpoint") {
      if (!tool.method || !tool.path)
        throw new Error(`Runtime artifact missing endpoint: ${tool.toolId}`);
      return {
        ...common,
        executionKind: "endpoint",
        method: tool.method,
        path: tool.path,
        tool: endpointToolToTool({
          ...definition,
          method: tool.method,
          path: tool.path,
        }),
      };
    }
    if (!contract.uiAction || !tool.actionBindingRef)
      throw new Error(`Runtime artifact missing UI action: ${tool.toolId}`);
    return {
      ...common,
      executionKind: "ui",
      actionBindingRef: tool.actionBindingRef,
      tool: uiActionToolToTool({ ...definition, action: contract.uiAction }),
    };
  });
  const generated: LoadedRuntimeArtifact = {
    setupArtifact,
    promptBundle,
    coverage,
    manifest,
    toolSearchSemantics: Object.fromEntries(
      tools.flatMap((tool) => {
        const synonyms = byId.get(tool.toolId)?.search?.synonyms;
        return synonyms?.length
          ? [[tool.modelName ?? modelFacingToolName(tool.name), { synonyms }]]
          : [];
      }),
    ),
    createToolBindings: () => bindings,
  };
  if (createContractBindings(generated).disabled.length)
    throw new Error("Runtime artifact binding integrity mismatch");
  return generated;
}

/** Only JSON is loaded; hashes detect corruption, not an untrusted publisher. Mount approved artifacts read-only. */
export async function loadRuntimeArtifact(
  directory: string,
): Promise<LoadedRuntimeArtifact> {
  const manifest = ManifestSchema.parse(
    JSON.parse(await boundedFile(resolve(directory, "manifest.json"), 4096)),
  );
  if (manifest.sdkVersion !== SDK_VERSION)
    throw new Error(
      `Runtime artifact SDK version mismatch: expected ${SDK_VERSION}`,
    );
  const text = await boundedFile(
    resolve(directory, "runtime.json"),
    MAX_ARTIFACT_BYTES,
  );
  if (hash(text) !== manifest.sha256)
    throw new Error("Runtime artifact integrity mismatch");
  return materialize(PayloadSchema.parse(JSON.parse(text)), manifest);
}
