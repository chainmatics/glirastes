import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { renderGeneratedModule } from "../codegen/tools/emit-module.js";
import { SDK_ROOT } from "../codegen/tools/__tests__/app-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAppFixture,
  removeAppFixtures,
} from "../codegen/tools/__tests__/app-fixture.js";
import { createContractBindings } from "../runtime/contract-bindings.js";
import { ToolContractsFileSchema } from "../codegen/tools/files.js";
import { buildRuntimeArtifact, loadRuntimeArtifact } from "./artifact.js";
import { createRegistryToolDiscovery } from "../runtime/tool-discovery.js";
import { defaultIntentRouterFor } from "../server/adapters/nextjs/default-intent-routing.js";

const response = {
  "200": {
    description: "Tasks",
    content: {
      "application/json": {
        schema: { type: "array", items: { type: "object" } },
      },
    },
  },
};
function doc(operation: Record<string, unknown> = {}) {
  return JSON.stringify({
    openapi: "3.1.0",
    security: [{ session: [] }],
    paths: {
      "/api/tasks": {
        get: { description: "List tasks", responses: response, ...operation },
      },
    },
  });
}
async function fixture(operation: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return createAppFixture(
    { "api/openapi.json": doc(operation) },
    {
      toolsConfig: {
        sources: [{ kind: "openapi", document: "api/openapi.json" }],
        ...config,
      },
    },
  );
}
afterEach(removeAppFixtures);

describe("runtime container artifact", () => {
  it("carries the tool labels per language locally and leaves the setup artifact one presentation", async () => {
    const app = await fixture(
      { "x-glirastes-title": { de: "Aufgaben zeigen", pl: "Pokaż zadania" } },
      { languages: ["en", "de", "pl"] },
    );
    await buildRuntimeArtifact({ projectRoot: app.root, outputDirectory: app.path("artifact") });
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    const name = Object.keys(loaded.toolTexts ?? {})[0]!;
    expect(loaded.toolTexts?.[name]?.labels?.pl?.approval).toBe("Pokaż zadania");
    expect(JSON.stringify(loaded.setupArtifact)).not.toContain("Pokaż zadania");
    const plain = await fixture();
    await buildRuntimeArtifact({ projectRoot: plain.root, outputDirectory: plain.path("artifact") });
    expect((await loadRuntimeArtifact(plain.path("artifact"))).toolTexts).toBeUndefined();
  }, 60_000);

  it("rejects required bodies that can be empty because the caller omits an empty object", async () => {
    const app = await fixture();
    const spec = JSON.parse(await app.read("api/openapi.json"));
    spec.paths["/api/tasks"].post = {
      description: "Reindex",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
      responses: response,
    };
    await app.write("api/openapi.json", JSON.stringify(spec));
    await expect(
      buildRuntimeArtifact({
        projectRoot: app.root,
        outputDirectory: app.path("artifact"),
      }),
    ).rejects.toThrow(/required body.*empty/);
  });

  it("builds data-only artifact and materializes the existing SDK bindings without customer Node code", async () => {
    const app = await fixture();
    await app.remove("package.json");
    const result = await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    expect(result.coverage.tools).toHaveLength(1);
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    expect(createContractBindings(loaded).disabled).toEqual([]);
    const bindings = loaded.createToolBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      executionKind: "endpoint",
      method: "GET",
      path: "/api/tasks",
    });
    expect(loaded.promptBundle.sections.planner).toContain("available tools");
    expect(
      JSON.parse(await app.read("artifact/runtime.json")),
    ).not.toHaveProperty("code");
  });

  it("carries and applies the x-glirastes-output-* fields through tool-contracts.json, the generated module and the container", async () => {
    const declared = {
      "x-glirastes-output-allowed-fields": ["data"],
      "x-glirastes-output-denied-fields": ["**.fileUrl"],
      "x-glirastes-output-default-fields": ["data[].title"],
    };
    const app = await fixture(declared);
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const written = ToolContractsFileSchema.parse(
      JSON.parse(await app.read(".glirastes/tool-contracts.json")),
    );
    expect(written.tools[0]).toMatchObject({
      outputAllowedFields: ["data"],
      outputDeniedFields: ["**.fileUrl"],
      outputDefaultFields: ["data[].title"],
    });
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    expect(payload.contracts.tools[0].outputDeniedFields).toEqual(["**.fileUrl"]);
    const module = renderGeneratedModule({
      modulePath: "generated.ts",
      artifact: payload.setupArtifact,
      contracts: payload.contracts.tools,
    });
    expect(module).toContain('        outputAllowedFields: [\n          "data"\n        ],\n');
    expect(module).toContain('        outputDeniedFields: [\n          "**.fileUrl"\n        ],\n');
    expect(module).toContain('        outputDefaultFields: [\n          "data[].title"\n        ],\n');
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    expect(createContractBindings(loaded).disabled).toEqual([]);
    const [binding] = loaded.createToolBindings();
    expect(binding!.tool).toMatchObject({
      outputAllowedFields: ["data"],
      outputDeniedFields: ["**.fileUrl"],
      outputDefaultFields: ["data[].title"],
    });
    // The container applies them: the bound tool reduces the backend answer.
    const result = await binding!.tool.execute({}, {
      currentDate: "2026-11-17", locale: "en-US",
      callEndpoint: async () => ({ ok: true, status: 200, data: [{ title: "T", fileUrl: "https://s3.example/x?sig=SIG" }] }),
    } as never);
    const { toolToAiTool } = await import("../server/core/index.js");
    const shown = await toolToAiTool(
      { ...binding!.tool, execute: async () => result },
      { currentDate: "2026-11-17", locale: "en-US" } as never,
    ).execute({});
    expect(JSON.stringify(shown)).not.toContain("SIG");
    expect(shown).toMatchObject({ data: [{ title: "T" }] });

    // Without the extensions nothing is written: existing outputs stay byte-identical.
    const plain = await fixture();
    await buildRuntimeArtifact({
      projectRoot: plain.root,
      outputDirectory: plain.path("artifact"),
    });
    expect(await plain.read(".glirastes/tool-contracts.json")).not.toContain("outputAllowedFields");
    const plainLoaded = await loadRuntimeArtifact(plain.path("artifact"));
    expect(plainLoaded.createToolBindings()[0]!.tool).not.toHaveProperty("outputAllowedFields");
  });

  it("refuses to build a container artifact for a tool with an invalid upper bound (fail closed)", async () => {
    for (const extension of ["x-glirastes-output-allowed-fields", "x-glirastes-output-denied-fields"]) {
      const app = await fixture({ [extension]: ["data[0]"] });
      await expect(
        buildRuntimeArtifact({ projectRoot: app.root, outputDirectory: app.path("artifact") }),
      ).rejects.toThrow(/output-(allowed|denied)-fields-invalid/);
    }
  });

  it("refuses an artifact whose tool-contracts.json declares the any-depth form outside outputDeniedFields", async () => {
    const app = await fixture({ "x-glirastes-output-allowed-fields": ["data"] });
    await buildRuntimeArtifact({ projectRoot: app.root, outputDirectory: app.path("artifact") });
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    payload.contracts.tools[0].outputAllowedFields = ["**.fileUrl"];
    expect(() => ToolContractsFileSchema.parse(payload.contracts)).toThrow();
  });

  it("carries x-glirastes-max-result-chars through tool-contracts.json, the generated module and the container", async () => {
    const app = await fixture({ "x-glirastes-max-result-chars": 40_000 });
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const written = ToolContractsFileSchema.parse(
      JSON.parse(await app.read(".glirastes/tool-contracts.json")),
    );
    expect(written.tools.map((tool) => tool.maxResultChars)).toEqual([40_000]);
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    expect(payload.contracts.tools[0].maxResultChars).toBe(40_000);
    const module = renderGeneratedModule({
      modulePath: "generated.ts",
      artifact: payload.setupArtifact,
      contracts: payload.contracts.tools,
    });
    expect(module).toContain("        maxResultChars: 40000,\n");
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    const [binding] = loaded.createToolBindings();
    expect(binding!.tool.maxResultChars).toBe(40_000);

    // Without the extension nothing is written: existing outputs stay byte-identical.
    const plain = await fixture();
    await buildRuntimeArtifact({
      projectRoot: plain.root,
      outputDirectory: plain.path("artifact"),
    });
    expect(await plain.read(".glirastes/tool-contracts.json")).not.toContain("maxResultChars");
    const plainLoaded = await loadRuntimeArtifact(plain.path("artifact"));
    expect(plainLoaded.createToolBindings()[0]!.tool).not.toHaveProperty("maxResultChars");
  });

  it("carries a query parameter description into tool-contracts.json, the generated module and the container", async () => {
    const app = await fixture({
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          description: "Omit to get all tasks",
          schema: { type: "integer" },
        },
      ],
    });
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const limit = { type: "integer", description: "Omit to get all tasks" };
    const written = ToolContractsFileSchema.parse(
      JSON.parse(await app.read(".glirastes/tool-contracts.json")),
    );
    expect(written.tools[0]!.contract!.input).toMatchObject({
      properties: { limit },
    });
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    const module = renderGeneratedModule({
      modulePath: "generated.ts",
      artifact: payload.setupArtifact,
      contracts: payload.contracts.tools,
    });
    expect(module).toContain("Omit to get all tasks");
    const [binding] = (
      await loadRuntimeArtifact(app.path("artifact"))
    ).createToolBindings();
    expect(
      (binding!.inputSchema as { jsonSchema?: unknown }).jsonSchema,
    ).toMatchObject({ properties: { limit } });
  });

  it("types a 204-only operation as no content, and the runtime result for a 204 matches it", async () => {
    const app = await fixture();
    const spec = JSON.parse(await app.read("api/openapi.json"));
    spec.paths["/api/devices/{id}"] = {
      delete: {
        description: "Delete device",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "204": { description: "Deleted" } },
      },
    };
    await app.write("api/openapi.json", JSON.stringify(spec));
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const report = JSON.parse(await app.read(".glirastes/tool-report.json"));
    expect(JSON.stringify(report)).not.toContain("output-contract-opaque");
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    const binding = loaded
      .createToolBindings()
      .find((candidate) => "method" in candidate && candidate.method === "DELETE")!;
    expect(
      (binding.outputSchema as { jsonSchema?: unknown }).jsonSchema,
    ).toMatchObject({ required: ["success"], additionalProperties: false });
    // A 204 has no body: the HTTP caller reads it as `undefined`.
    const result = await binding.tool.execute(
      { id: "d1" },
      {
        currentDate: new Date(0),
        locale: "en-US",
        callEndpoint: async () => ({ ok: true, status: 204, data: undefined }),
      } as never,
    );
    // What the model receives is the JSON of the result.
    const received = JSON.parse(JSON.stringify(result));
    expect(received).toEqual({ success: true });
    expect(binding.outputSchema.safeParse(received).success).toBe(true);
  });

  it("has the same tool bindings and schemas as the existing generated module", async () => {
    const app = await fixture({
      parameters: [{ name: "status", in: "query", schema: { type: "string" } }],
    });
    const spec = JSON.parse(await app.read("api/openapi.json"));
    spec.paths["/api/tasks"].post = {
      description: "Create task",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          },
        },
      },
      responses: response,
    };
    await app.write("api/openapi.json", JSON.stringify(spec));
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    const module = renderGeneratedModule({
      modulePath: "generated.mjs",
      artifact: payload.setupArtifact,
      contracts: payload.contracts.tools,
    })
      .replaceAll(
        "'glirastes/runtime'",
        JSON.stringify(
          pathToFileURL(resolve(SDK_ROOT, "dist/runtime/index.js")).href,
        ),
      )
      .replaceAll(
        "'glirastes/server'",
        JSON.stringify(
          pathToFileURL(resolve(SDK_ROOT, "dist/server/index.js")).href,
        ),
      );
    await app.write("generated.mjs", module);
    const emitted = await import(
      /* @vite-ignore */ pathToFileURL(app.path("generated.mjs")).href
    );
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    const describe = (bindings: ReturnType<typeof loaded.createToolBindings>) =>
      bindings.map(({ tool, inputSchema, outputSchema, ...rest }) => ({
        ...rest,
        id: tool.id,
        description: tool.description,
        needsApproval: tool.needsApproval,
        input: (inputSchema as { jsonSchema?: unknown }).jsonSchema,
        output: (outputSchema as { jsonSchema?: unknown }).jsonSchema,
      }));
    expect(describe(loaded.createToolBindings())).toEqual(
      describe(emitted.createToolBindings()),
    );
    expect(loaded.toolSearchSemantics).toEqual(emitted.toolSearchSemantics);
    const calls: unknown[][] = [];
    for (const generated of [loaded, emitted]) {
      const requests: unknown[] = [];
      const context = {
        currentDate: new Date(0),
        locale: "en-US",
        callEndpoint: async (request: unknown) => {
          requests.push(request);
          return { ok: true, status: 200, data: [] };
        },
      };
      for (const binding of generated.createToolBindings()) {
        await binding.tool.execute(
          binding.method === "GET" ? { status: "open" } : { title: "test" },
          context,
        );
      }
      calls.push(requests);
    }
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/api/tasks?status=open",
      }),
    );
    expect(calls[0]).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/api/tasks",
        body: { title: "test" },
      }),
    );
  });

  it("lets the example sentences of tool-semantics.json reach find_tools and the start set, in the container and the generated module", async () => {
    const app = await fixture();
    const examples = [
      "Zeig mir meine Erledigungen",
      "Welche Erledigungen sind offen?",
      "Erledigungen von heute anzeigen",
    ];
    await app.write(
      ".glirastes/tool-semantics.json",
      JSON.stringify({
        schemaVersion: 1,
        tools: [
          {
            stableKey: "GET /api/tasks",
            synonyms: { de: ["Aufgabenliste"] },
            examples: { de: examples },
          },
        ],
      }),
    );
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const payload = JSON.parse(await app.read("artifact/runtime.json"));
    const loaded = await loadRuntimeArtifact(app.path("artifact"));
    const [binding] = loaded.createToolBindings();
    // The model-facing name the container materializes next to each binding.
    const name = (binding as unknown as { modelName: string }).modelName;
    expect(name).toBe("tasks_list");
    // The container: the loaded semantics carry the examples.
    expect(loaded.toolSearchSemantics?.[name]).toEqual({
      synonyms: ["Aufgabenliste"],
      examples: [...examples].sort(),
    });
    // The embedded app: the generated module carries the same map.
    const module = renderGeneratedModule({
      modulePath: "generated.ts",
      artifact: payload.setupArtifact,
      contracts: payload.contracts.tools,
    });
    expect(module).toContain(
      `export const toolSearchSemantics = ${JSON.stringify({ [name]: { examples: [...examples].sort(), synonyms: ["Aufgabenliste"] } }, null, 2)} as const;`,
    );
    const registry = { [name]: binding!.tool };
    const query = "Erledigungen";
    const discovery = createRegistryToolDiscovery({
      turnId: "t",
      registry,
      semantics: loaded.toolSearchSemantics,
    });
    expect(discovery.search(query).map((result) => result.name)).toEqual([name]);
    expect(
      defaultIntentRouterFor({
        registry,
        semantics: loaded.toolSearchSemantics,
      }).route({ text: query }).toolNames,
    ).toContain(name);
  });

  it("rejects payload tampering and incompatible SDK versions", async () => {
    const app = await fixture();
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const original = await app.read("artifact/runtime.json");
    await app.write("artifact/runtime.json", original + " ");
    await expect(loadRuntimeArtifact(app.path("artifact"))).rejects.toThrow(
      /integrity/,
    );
    await app.write("artifact/runtime.json", original);
    const manifest = JSON.parse(await app.read("artifact/manifest.json"));
    await app.write(
      "artifact/manifest.json",
      JSON.stringify({ ...manifest, sdkVersion: "99.0.0" }),
    );
    await expect(loadRuntimeArtifact(app.path("artifact"))).rejects.toThrow(
      /SDK version/,
    );
  });

  it.each([
    {
      parameters: [
        {
          name: "x-mode",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      ],
    },
    {
      parameters: [
        {
          name: "filter",
          in: "query",
          style: "deepObject",
          schema: { type: "object" },
        },
      ],
    },
    {
      parameters: [
        {
          name: "id",
          in: "query",
          schema: { $ref: "https://invalid.test/schema.json" },
        },
      ],
    },
    {
      requestBody: {
        content: { "multipart/form-data": { schema: { type: "object" } } },
      },
    },
    {
      responses: {
        "200": {
          description: "Task",
          content: {
            "application/json": {
              schema: { type: "object", unevaluatedProperties: false },
            },
          },
        },
      },
    },
  ])(
    "blocks an unsupported operation instead of silently enabling it (%j)",
    async (operation) => {
      const app = await fixture(operation);
      await expect(
        buildRuntimeArtifact({
          projectRoot: app.root,
          outputDirectory: app.path("artifact"),
        }),
      ).rejects.toThrow(/unsupported/);
    },
  );

  it("validates only the operations the generator selects (opt-in, x-glirastes-tool)", async () => {
    const upload = {
      description: "Upload",
      requestBody: {
        content: { "multipart/form-data": { schema: { type: "object" } } },
      },
      responses: response,
    };
    const write = async (
      selection: "all" | "opt-in" | undefined,
      tasks: Record<string, unknown>,
      uploadMarker?: boolean,
    ) => {
      const app = await createAppFixture(
        {
          "api/openapi.json": JSON.stringify({
            openapi: "3.1.0",
            security: [{ session: [] }],
            paths: {
              "/api/tasks": { get: { description: "List tasks", responses: response, ...tasks } },
              "/api/uploads": {
                post: uploadMarker === undefined ? upload : { ...upload, "x-glirastes-tool": uploadMarker },
              },
            },
          }),
        },
        {
          toolsConfig: {
            sources: [{ kind: "openapi", document: "api/openapi.json", ...(selection ? { selection } : {}) }],
          },
        },
      );
      return buildRuntimeArtifact({ projectRoot: app.root, outputDirectory: app.path("artifact") });
    };
    // The unsupported upload fails the build as long as it is selected.
    await expect(write(undefined, {})).rejects.toThrow(/POST \/api\/uploads: unsupported request body/);
    await expect(write("opt-in", { "x-glirastes-tool": true }, true)).rejects.toThrow(/unsupported request body/);
    // Unmarked under opt-in, or opted out in either mode: skipped, like in the generator.
    const optIn = await write("opt-in", { "x-glirastes-tool": true, "x-glirastes-roles": ["task.read"] });
    expect(optIn.coverage.tools).toHaveLength(1);
    expect(optIn.coverage.excluded).toEqual([
      // The generator names the existing reason first.
      { stableKey: "POST /api/uploads", reason: "unsupported-body", origin: "code" },
    ]);
    expect((await write("all", {}, false)).coverage.tools).toHaveLength(1);
    // Nothing selected: nothing to validate, and no tool.
    expect((await write("opt-in", {})).coverage.tools).toHaveLength(0);
  });

  it("builds from an OpenAPI 3.0 export and keeps nullable parameters unsupported", async () => {
    const app = await fixture();
    const spec = JSON.parse(await app.read("api/openapi.json"));
    spec.openapi = "3.0.3";
    spec.paths["/api/tasks"].get.responses["200"].content[
      "application/json"
    ].schema.items = {
      type: "object",
      properties: { notes: { type: "string", nullable: true } },
    };
    await app.write("api/openapi.json", JSON.stringify(spec));
    const result = await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    expect(result.coverage.tools).toHaveLength(1);

    spec.paths["/api/tasks"].get.parameters = [
      { name: "q", in: "query", schema: { type: "string", nullable: true } },
    ];
    await app.write("api/openapi.json", JSON.stringify(spec));
    await expect(
      buildRuntimeArtifact({
        projectRoot: app.root,
        outputDirectory: app.path("artifact-nullable"),
      }),
    ).rejects.toThrow(/explicit scalar or scalar-array type/);
  });

  it("names the OpenAPI version the container build does not read", async () => {
    const app = await fixture();
    const spec = JSON.parse(await app.read("api/openapi.json"));
    spec.openapi = "3.2.0";
    await app.write("api/openapi.json", JSON.stringify(spec));
    await expect(
      buildRuntimeArtifact({
        projectRoot: app.root,
        outputDirectory: app.path("artifact"),
      }),
    ).rejects.toThrow(
      "OpenAPI unsupported: is OpenAPI 3.2.0; the generator reads OpenAPI 3.0 and 3.1 exports",
    );
  });

  it("keeps explicitly ignored unsupported operations in coverage", async () => {
    const app = await fixture({
      "x-glirastes-ignore": true,
      requestBody: { content: { "multipart/form-data": {} } },
    });
    const result = await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    expect(result.coverage.excluded).toEqual([
      expect.objectContaining({ stableKey: "GET /api/tasks" }),
    ]);
    expect(
      (await loadRuntimeArtifact(app.path("artifact"))).createToolBindings(),
    ).toEqual([]);
  });

  it("frozen build detects an endpoint change and does not replace an existing artifact", async () => {
    const app = await fixture();
    await buildRuntimeArtifact({
      projectRoot: app.root,
      outputDirectory: app.path("artifact"),
    });
    const before = await app.read("artifact/runtime.json");
    await app.write(
      "api/openapi.json",
      doc({ description: "Changed contract" }),
    );
    await expect(
      buildRuntimeArtifact({
        projectRoot: app.root,
        outputDirectory: app.path("artifact"),
        mode: "frozen",
      }),
    ).rejects.toThrow();
    expect(await app.read("artifact/runtime.json")).toBe(before);
  });
});
