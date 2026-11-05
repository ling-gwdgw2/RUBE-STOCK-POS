import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sqlPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sql');
const checksumPath = resolve('packages/core-engine/migrations/0001_initial_v3_1_schema.sha256');

// Normalize CRLF -> LF so SHA-256 is deterministic across Windows and Linux/macOS
const sqlContent = readFileSync(sqlPath, 'utf8').replace(/\r\n/g, '\n');
const sha256Hex = createHash('sha256').update(sqlContent).digest('hex');

const shouldUpdate = process.argv.includes('--update') || !existsSync(checksumPath);
if (shouldUpdate) {
  writeFileSync(checksumPath, `${sha256Hex}  0001_initial_v3_1_schema.sql\n`, 'utf8');
} else {
  const recordedLine = readFileSync(checksumPath, 'utf8').trim();
  const recordedHash = recordedLine.split(/\s+/)[0];
  if (recordedHash !== sha256Hex) {
    throw new Error(
      `Schema SHA-256 mismatch! Expected ${recordedHash} from .sha256 file, but computed ${sha256Hex}`
    );
  }
}

const tableMatches = [...sqlContent.matchAll(/CREATE\s+TABLE\s+([a-z_]+)/gi)].map((m) => m[1]);
const triggerMatches = [...sqlContent.matchAll(/CREATE\s+TRIGGER\s+([a-z_]+)/gi)].map((m) => m[1]);

console.log(`Schema Checksum (SHA-256): ${sha256Hex}`);
console.log(`Tables Found (${tableMatches.length}): ${tableMatches.join(', ')}`);
console.log(`Triggers Found (${triggerMatches.length}): ${triggerMatches.join(', ')}`);

if (tableMatches.length !== 34) {
  throw new Error(`Expected exactly 34 tables in v3.1 schema, found ${tableMatches.length}`);
}
if (triggerMatches.length !== 4) {
  throw new Error(`Expected 4 immutable audit triggers, found ${triggerMatches.length}`);
}
