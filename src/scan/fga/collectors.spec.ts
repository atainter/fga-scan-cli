import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDataModelHints } from './collectors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fga-scan-collectors-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('collectDataModelHints', () => {
  it('detects a Prisma schema', async () => {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(join(dir, 'prisma', 'schema.prisma'), 'model Organization {}');

    const hints = await collectDataModelHints(dir);

    const prisma = hints.sources.find((s) => s.kind === 'prisma');
    expect(prisma).toBeDefined();
    expect(prisma!.files).toEqual(['prisma/schema.prisma']);
  });

  it('detects SQL migrations and TypeORM entities', async () => {
    await mkdir(join(dir, 'migrations'), { recursive: true });
    await writeFile(join(dir, 'migrations', '001_init.sql'), 'CREATE TABLE orgs ();');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'org.entity.ts'), '@Entity() class Org {}');

    const hints = await collectDataModelHints(dir);

    expect(hints.sources.map((s) => s.kind)).toEqual(expect.arrayContaining(['sql-migrations', 'typeorm']));
  });

  it('ignores node_modules', async () => {
    await mkdir(join(dir, 'node_modules', 'dep', 'prisma'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'dep', 'prisma', 'schema.prisma'), 'model X {}');

    const hints = await collectDataModelHints(dir);

    expect(hints.sources.find((s) => s.kind === 'prisma')).toBeUndefined();
  });

  it('returns no sources for an empty project', async () => {
    const hints = await collectDataModelHints(dir);

    expect(hints.sources).toEqual([]);
  });
});
