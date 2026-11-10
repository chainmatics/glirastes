# Deferred SDK surfaces

The Foundation package intentionally exposes and ships only the surfaces used
by the Get It Done pilot and its acceptance tests.

## Shipped now

- root framework-neutral types used by the consumer
- `contracts`
- `runtime` and the Vercel AI SDK engine
- standalone STT
- signed runtime sync
- local server pipeline, local PII shield, and the Next.js adapter
- React chat, Vercel transport, and styles
- runtime test harness used by Get It Done
- Next.js route scan plus scoped `scan --sync`

## Deferred

The implementation remains in the repository, but is not exported or included
in the package artifact until its own product and acceptance gates are green:

- LangGraph transport
- NestJS adapter and NestJS scanner
- OpenAPI generator
- Skill generator
- MCP generator
- automatic output recommendation and generated-asset sync
- legacy Lancer client
- remote Aegis detector bridge
- CLI scaffolding, upgrade analysis, and bundled-skill installation

`src/cli/deferred-full.ts` preserves the former broad CLI implementation for
future reintroduction. It is excluded from compilation and packaging.
