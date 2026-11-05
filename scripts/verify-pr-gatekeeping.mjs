/**
 * RUBE-STOCK-POS v3.1 Section 6.1 PR Gatekeeping & Static Analysis Verifier
 * (`scripts/verify-pr-gatekeeping.mjs`)
 *
 * Enforces the 3 mandatory Pull Request Gatekeeping Rules from `IMPLEMENTATION_PLAYBOOK.md` Section 6.1:
 * 1. Static Analysis for Money, Stock & `i128` / `BigInt` Intermediate Math:
 *    - Zero `f32` / `f64` floating-point declarations across all Rust crates (`packages/`).
 *    - Zero `parseFloat` calls across all TypeScript packages (`packages/`).
 *    - Mandatory presence of `i128` (`round_div`) in Rust `core-engine` and `BigInt` (`roundDivBigInt`) in TypeScript.
 * 2. Cross-Language Contract Compatibility Check (`packages/shared-contracts`):
 *    - Verifies parity of `MilliUnit`, `Satang`, `MicroBaht`, `BasisPoints`, `BusinessProfile`,
 *      `TaxMode`, `ComponentRole`, and `ModifierMode` between Rust (`lib.rs`) and TypeScript (`ipc-commands.ts` / `fixed-point.ts`).
 * 3. Schema DDL & 4 Immutable Audit Triggers Checksum Lock (`0001_initial_v3_1_schema.sha256`).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function walkFiles(dir, extFilter) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkFiles(full, extFilter));
    } else if (full.endsWith(extFilter)) {
      results.push(full);
    }
  }
  return results;
}

const rootDir = resolve(import.meta.dirname, '..');
const packagesDir = join(rootDir, 'packages');

const rustFiles = walkFiles(packagesDir, '.rs');
const tsFiles = walkFiles(packagesDir, '.ts');

// Rule 1A: Zero f32 / f64 in Rust source files
const floatRegexRust = /\b(f32|f64)\b/;
const rustViolations = [];
for (const file of rustFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const codeOnly = line.split('//')[0] ?? '';
    if (floatRegexRust.test(codeOnly)) {
      rustViolations.push(`${file}:${idx + 1}: ${line.trim()}`);
    }
  });
}

if (rustViolations.length > 0) {
  console.error('❌ PR Gatekeeping Rule 1 FAILED: Floating-point types (f32/f64) detected in Rust:');
  for (const v of rustViolations) console.error(`  - ${v}`);
  process.exit(1);
}

// Rule 1B: Zero parseFloat in TypeScript source files
const tsViolations = [];
for (const file of tsFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const codeOnly = line.split('//')[0] ?? '';
    if (/\bparseFloat\s*\(/.test(codeOnly)) {
      tsViolations.push(`${file}:${idx + 1}: ${line.trim()}`);
    }
  });
}

if (tsViolations.length > 0) {
  console.error('❌ PR Gatekeeping Rule 1 FAILED: parseFloat() detected in TypeScript:');
  for (const v of tsViolations) console.error(`  - ${v}`);
  process.exit(1);
}

// Rule 1C: Mandatory i128 & BigInt intermediate rounding primitives
const mathI128Rust = readFileSync(
  join(packagesDir, 'core-engine/src/domains/math_i128.rs'),
  'utf8'
);
const fixedPointTs = readFileSync(
  join(packagesDir, 'shared-contracts/src/fixed-point.ts'),
  'utf8'
);
if (!mathI128Rust.includes('pub fn round_div_i128(numerator: i128, denominator: i128)')) {
  console.error('❌ PR Gatekeeping Rule 1 FAILED: Missing i128 round_div_i128 in math_i128.rs');
  process.exit(1);
}
if (!fixedPointTs.includes('export function roundDivBigInt(numerator: bigint, denominator: bigint)')) {
  console.error('❌ PR Gatekeeping Rule 1 FAILED: Missing BigInt roundDivBigInt in fixed-point.ts');
  process.exit(1);
}

// Rule 2: Contract Compatibility Check between Rust `lib.rs` and TypeScript `ipc-commands.ts` / `fixed-point.ts`
const sharedRust = readFileSync(join(packagesDir, 'shared-contracts/src/lib.rs'), 'utf8');
const sharedTs =
  fixedPointTs +
  '\n' +
  readFileSync(join(packagesDir, 'shared-contracts/src/ipc-commands.ts'), 'utf8');

const requiredContractSymbols = [
  'MilliUnit',
  'Satang',
  'MicroBaht',
  'BasisPoints',
  'BusinessProfile',
  'TaxMode',
  'ComponentRole',
  'ModifierMode',
];

for (const sym of requiredContractSymbols) {
  if (!sharedRust.includes(sym) || !sharedTs.includes(sym)) {
    console.error(
      `❌ PR Gatekeeping Rule 2 FAILED: Contract symbol '${sym}' out of sync between Rust and TypeScript`
    );
    process.exit(1);
  }
}

// Rule 3: Schema Checksum Lock
const schemaSql = readFileSync(
  join(packagesDir, 'core-engine/migrations/0001_initial_v3_1_schema.sql'),
  'utf8'
).replace(/\r\n/g, '\n');
const expectedChecksum = readFileSync(
  join(packagesDir, 'core-engine/migrations/0001_initial_v3_1_schema.sha256'),
  'utf8'
)
  .trim()
  .split(/\s+/)[0];
const actualChecksum = createHash('sha256').update(schemaSql).digest('hex');

if (actualChecksum !== expectedChecksum) {
  console.error(
    `❌ PR Gatekeeping Rule 3 FAILED: Schema checksum mismatch (expected ${expectedChecksum}, got ${actualChecksum})`
  );
  process.exit(1);
}

console.log('✅ PR Gatekeeping Rule 1 PASSED: Zero f32/f64/parseFloat & i128/BigInt math verified across', rustFiles.length, 'Rust files and', tsFiles.length, 'TS files.');
console.log('✅ PR Gatekeeping Rule 2 PASSED: Rust <-> TypeScript shared-contracts symbols verified:', requiredContractSymbols.join(', '));
console.log('✅ PR Gatekeeping Rule 3 PASSED: SQLite v3.1 Schema SHA-256 Checksum verified:', actualChecksum);
