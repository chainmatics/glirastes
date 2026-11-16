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
import { buildRuntimeArtifact, loadRuntimeArtifact } from "./artifact.js";

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
async function fixture(operation: Record<string, unknown> = {}) {
  return createAppFixture(
    { "api/openapi.json": doc(operation) },
    {
      toolsConfig: {
        sources: [{ kind: "openapi", document: "api/openapi.json" }],
      },
    },
  );
}
afterEach(removeAppFixtures);

describe("runtime container artifact", () => {
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
