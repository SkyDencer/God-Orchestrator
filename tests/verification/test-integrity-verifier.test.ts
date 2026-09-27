import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestIntegrityVerifier } from '../../src/verification/test-integrity-verifier.js';

/**
 * Build a minimal fixture project at tmpDir that contains:
 *   - tests/unit/alpha.test.ts  (3 expect calls, 2 it blocks)
 *   - tests/unit/beta.test.ts   (2 expect calls, 1 it block + 1 it.skip)
 *   - vitest.config.ts
 *   - package.json (with test scripts and vitest devDependency)
 */
function createFixtureProject(tmpDir: string): string {
  // Create directory structure.
  fs.mkdirSync(path.join(tmpDir, 'tests', 'unit'), { recursive: true });

  // Write alpha.test.ts.
  const alpha = `import { describe, it, expect } from 'vitest';\n\n
describe('alpha', () => {
  it('passes one', () => {
    expect(1).toBe(1);
    expect(2).toBe(2);
  });
  it('passes two', () => {
    expect(true).toBe(true);
  });
});
`;
  fs.writeFileSync(path.join(tmpDir, 'tests', 'unit', 'alpha.test.ts'), alpha, 'utf8');

  // Write beta.test.ts — includes one skipped test.
  const beta = `import { describe, it, expect } from 'vitest';\n\n
describe('beta', () => {
  it('runs', () => {
    expect('hello').toEqual('hello');
  });
  it.skip('skipped', () => {
    expect(1).toBe(2);
  });
});
`;
  fs.writeFileSync(path.join(tmpDir, 'tests', 'unit', 'beta.test.ts'), beta, 'utf8');

  // Write vitest.config.ts.
  const config = `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true } });\n`;
  fs.writeFileSync(path.join(tmpDir, 'vitest.config.ts'), config, 'utf8');

  // Write package.json with test-relevant fields.
  const pkg = {
    name: 'fixture-test-integrity',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^2.0.0' },
  };
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify(pkg, null, 2),
    'utf8',
  );

  return tmpDir;
}

function makeVerifier(projectRoot: string): TestIntegrityVerifier {
  return new TestIntegrityVerifier(projectRoot);
}

describe('TestIntegrityVerifier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures a snapshot with correct file list, hashes, assertion counts and skip counts', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const snap = await verifier.captureSnapshot();

    // Two test files expected.
    expect(snap.testFiles).toHaveLength(2);
    const base = path.basename(snap.testFiles[0]);
    expect(['alpha.test.ts', 'beta.test.ts']).toContain(base);

    // Both files have sha256 hashes (64 hex chars).
    for (const f of snap.testFiles) {
      expect(snap.fileHashes[f].length).toBe(64);
    }

    // Alpha has 3 expects + 2 it = 5 assertions.
    // Beta has 2 expects + 1 it (non-skipped) + 1 it.skip = 3 assertions.
    // Total = 8.
    expect(snap.assertionCount).toBe(8);

    // One skip in beta.
    expect(snap.skipCount).toBe(1);

    // Coverage is 0 (no coverage tooling in fixture).
    expect(snap.coveragePct).toBe(0);

    // Config hash is a 64-char hex string.
    expect(snap.testConfigHash.length).toBe(64);
  });

  it('returns passed when nothing changed between snapshots', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const before = await verifier.captureSnapshot();
    const result = await verifier.compareAfter(before);

    expect(result.status).toBe('passed');
    expect(result.name).toBe('test-integrity');
    expect(result.summary).toBe('All integrity checks passed');
  });

  it('fails when a test file is deleted', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const before = await verifier.captureSnapshot();

    // Delete alpha.test.ts.
    const alphaPath = path.join(tmpDir, 'tests', 'unit', 'alpha.test.ts');
    fs.unlinkSync(alphaPath);

    const result = await verifier.compareAfter(before);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Test file deleted');
  });

  it('adversarial: delete real test → fail; restore → pass', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);

    // Capture clean state.
    const before = await verifier.captureSnapshot();
    expect(before.testFiles).toHaveLength(2);
    expect(before.assertionCount).toBe(8);
    expect(before.skipCount).toBe(1);

    // ADVERSARIAL: delete beta.test.ts (a real test file).
    const betaPath = path.join(tmpDir, 'tests', 'unit', 'beta.test.ts');
    const betaContent = fs.readFileSync(betaPath, 'utf8');
    fs.unlinkSync(betaPath);

    // After deletion, compare should FAIL.
    const failed = await verifier.compareAfter(before);
    expect(failed.status).toBe('failed');
    expect(failed.summary).toContain('Test file deleted');
    expect(failed.summary).toContain('Assertion count decreased');

    // Restore the deleted file.
    fs.writeFileSync(betaPath, betaContent, 'utf8');

    // After restoration, compare should PASS.
    const restored = await verifier.compareAfter(before);
    expect(restored.status).toBe('passed');
  });

  it('fails when assertion count drops', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const before = await verifier.captureSnapshot();

    // Overwrite alpha.test.ts to remove one expect call.
    const alphaPath = path.join(tmpDir, 'tests', 'unit', 'alpha.test.ts');
    const reduced = `import { describe, it, expect } from 'vitest';\n\n
describe('alpha', () => {
  it('passes one', () => {
    expect(1).toBe(1);
  });
});
`;
    fs.writeFileSync(alphaPath, reduced, 'utf8');

    const result = await verifier.compareAfter(before);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Assertion count decreased');
  });

  it('fails when skip count increases', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const before = await verifier.captureSnapshot();

    // Add an additional it.skip to alpha.test.ts.
    const alphaPath = path.join(tmpDir, 'tests', 'unit', 'alpha.test.ts');
    const original = fs.readFileSync(alphaPath, 'utf8');
    const augmented = original.replace(
      "});\n",
      "  it.skip('newly skipped', () => { expect(1).toBe(2); });\n});\n",
    );
    fs.writeFileSync(alphaPath, augmented, 'utf8');

    const result = await verifier.compareAfter(before);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Skip count increased');
  });

  it('fails when test config changes', async () => {
    createFixtureProject(tmpDir);
    const verifier = makeVerifier(tmpDir);
    const before = await verifier.captureSnapshot();

    // Modify vitest.config.ts.
    const configPath = path.join(tmpDir, 'vitest.config.ts');
    const original = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(
      configPath,
      original.replace('globals: true', 'globals: false'),
      'utf8',
    );

    const result = await verifier.compareAfter(before);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Test config changed');
  });
});
