/**
 * Fails when the SDK source contains a model call, provider import, dynamic
 * import or network call that the reviewed inventory
 * (src/contracts/privacy-egress-inventory.json) does not name, or when the
 * inventory names one that no longer exists.
 *
 *   bun scripts/check-model-egress.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkEgressInventory, EgressInventorySchema, scanTreeForEgress } from '../src/codegen/model-egress.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const inventory = EgressInventorySchema.parse(
  JSON.parse(readFileSync(new URL('../src/contracts/privacy-egress-inventory.json', import.meta.url), 'utf8')),
);
const findings = scanTreeForEgress(root);
const violations = checkEgressInventory(findings, inventory);
for (const violation of violations) {
  console.error(`${violation.code}: ${violation.file}${violation.line ? `:${violation.line}` : ''} (${violation.symbol})`);
}
console.log(`model egress: ${findings.length} reviewed site(s), ${violations.length} violation(s)`);
process.exit(violations.length === 0 ? 0 : 1);
