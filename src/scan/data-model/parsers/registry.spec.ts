import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDataModelDeterministically } from './registry.js';
import { collectDataModelHints } from '../../fga/collectors.js';
import { parseDbml } from './dbml.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fga-registry-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseDataModelDeterministically', () => {
  it('parses a Prisma project end-to-end from hints', async () => {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(
      join(dir, 'prisma', 'schema.prisma'),
      `model Org {
  id       String    @id
  projects Project[]
}

model Project {
  id    String @id
  org   Org    @relation(fields: [orgId], references: [id])
  orgId String
}`,
    );

    const hints = await collectDataModelHints(dir);
    const result = await parseDataModelDeterministically(dir, hints);

    expect(result).not.toBeNull();
    expect(result!.parser).toBe('prisma');
    expect(result!.files).toEqual(['prisma/schema.prisma']);
    expect(result!.discovery.entities.map((e) => e.name).sort()).toEqual(['Org', 'Project']);
  });

  it('prefers the latest drizzle snapshot', async () => {
    await mkdir(join(dir, 'drizzle', 'meta'), { recursive: true });
    const table = (name: string) => ({
      name,
      columns: { id: { name: 'id', primaryKey: true } },
      foreignKeys: {},
    });
    await writeFile(
      join(dir, 'drizzle', 'meta', '0000_snapshot.json'),
      JSON.stringify({ tables: { old: table('old_table') } }),
    );
    await writeFile(
      join(dir, 'drizzle', 'meta', '0001_snapshot.json'),
      JSON.stringify({ tables: { current: table('current_table') } }),
    );

    const hints = await collectDataModelHints(dir);
    const result = await parseDataModelDeterministically(dir, hints);

    expect(result!.parser).toBe('drizzle-snapshot');
    expect(result!.discovery.entities.map((e) => e.name)).toEqual(['current_table']);
  });

  it('parses SQL migrations when no higher-fidelity source exists', async () => {
    await mkdir(join(dir, 'migrations'), { recursive: true });
    await writeFile(
      join(dir, 'migrations', '001_init.sql'),
      'CREATE TABLE orgs (id uuid PRIMARY KEY); CREATE TABLE apps (id uuid PRIMARY KEY, org_id uuid REFERENCES orgs(id));',
    );

    const hints = await collectDataModelHints(dir);
    const result = await parseDataModelDeterministically(dir, hints);

    expect(result!.parser).toBe('sql');
    expect(result!.discovery.entities.map((e) => e.name).sort()).toEqual(['apps', 'orgs']);
  });

  it('returns null when no deterministic source exists', async () => {
    const hints = await collectDataModelHints(dir);
    expect(await parseDataModelDeterministically(dir, hints)).toBeNull();
  });
});

describe('parseDbml', () => {
  it('parses a DBML file with refs', async () => {
    const discovery = await parseDbml(
      'schema.dbml',
      `Table orgs {
  id uuid [pk]
  name text
}

Table apps {
  id uuid [pk]
  org_id uuid [ref: > orgs.id]
}`,
    );

    expect(discovery).not.toBeNull();
    expect(discovery!.entities.map((e) => e.name).sort()).toEqual(['apps', 'orgs']);
    const apps = discovery!.entities.find((e) => e.name === 'apps')!;
    expect(apps.relationships).toContainEqual({ to: 'orgs', kind: 'belongsTo', via: 'org_id' });
  });
});
