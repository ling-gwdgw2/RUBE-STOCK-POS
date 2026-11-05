import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sqlPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sql');
const checksumPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sha256');

const sqlContent = readFileSync(sqlPath, 'utf8');
const sha256Hex = createHash('sha256').update(sqlContent).digest('hex');

writeFileSync(checksumPath, `${sha256Hex}  0001_initial_v3_1_schema.sql\n`, 'utf8');

const tableMatches = [...sqlContent.matchAll(/CREATE\s+TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
const triggerMatches = [...sqlContent.matchAll(/CREATE\s+TRIGGER\s+([a-z_]+)/gi)].map((m) => m[1]);

console.log(`Schema Checksum (SHA-256): ${sha256Hex}`);
console.log(`Tables Found (${tableMatches.length}): ${tableMatches.join(', ')}`);
console.log(`Triggers Found (${triggerMatches.length}): ${triggerMatches.join(', ')}`);

if (tableMatches.length !== 34) {
  throw new Error(`Expected exactly 34 tables in v3.1 schema, found ${tableMatches.length}`);
}
if (triggerMatches.length !== 3) {
  throw new Error(`Expected 3 immutable audit triggers, found ${triggerMatches.length}`);
}
