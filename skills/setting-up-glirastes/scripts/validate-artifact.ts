import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppSetupArtifactSchema } from 'glirastes/contracts';

const artifactPath = process.argv[2];
if (!artifactPath) {
  throw new Error('Usage: validate-artifact.ts <setup-artifact.json>');
}

const parsed = AppSetupArtifactSchema.safeParse(JSON.parse(
  readFileSync(resolve(artifactPath), 'utf8'),
));
if (!parsed.success) {
  const paths = parsed.error.issues
    .map((issue) => issue.path.join('.') || '<root>')
    .join(', ');
  throw new Error(`Invalid setup artifact at: ${paths}`);
}

console.log(
  `Valid setup artifact ${parsed.data.artifactId} `
  + `with ${parsed.data.tools.length} tools.`,
);
