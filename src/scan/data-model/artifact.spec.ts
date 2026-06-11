import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeModelArtifact, parseModelArtifact, parseMermaidErd, loadModelArtifact } from './artifact.js';
import type { DataModelDiscovery } from './types.js';

const discovery: DataModelDiscovery = {
  source: 'prisma',
  summary: 'Tracker.',
  entities: [
    {
      name: 'Organization',
      filePath: 'prisma/schema.prisma',
      relationships: [{ to: 'Project', kind: 'hasMany', via: 'organizationId' }],
    },
    { name: 'Project', filePath: 'prisma/schema.prisma', relationships: [] },
  ],
  domains: [{ name: 'Projects', entities: ['Organization', 'Project'] }],
};

describe('serializeModelArtifact / parseModelArtifact round-trip', () => {
  it('round-trips a discovery through the versioned envelope', () => {
    const serialized = serializeModelArtifact(discovery, '/tmp/app');
    const parsed = JSON.parse(serialized);
    expect(parsed.kind).toBe('workos-data-model');
    expect(parsed.version).toBe(1);
    expect(parsed.project).toBe('/tmp/app');

    const loaded = parseModelArtifact(serialized, 'model.json');
    expect(loaded.entities.map((e) => e.name)).toEqual(['Organization', 'Project']);
    expect(loaded.entities[0].relationships[0]).toEqual({ to: 'Project', kind: 'hasMany', via: 'organizationId' });
    expect(loaded.domains.map((d) => d.name)).toEqual(['Projects']);
  });
});

describe('parseModelArtifact with raw JSON', () => {
  it('accepts a hand-written discovery-shaped object and defaults missing filePath to the artifact', () => {
    const handWritten = JSON.stringify({
      entities: [
        { name: 'Workspace', relationships: [{ to: 'Doc', kind: 'hasMany' }] },
        { name: 'Doc', relationships: [] },
      ],
      domains: [{ name: 'Docs', entities: ['Workspace', 'Doc'] }],
    });
    const loaded = parseModelArtifact(handWritten, 'my-model.json');

    expect(loaded.entities.map((e) => e.filePath)).toEqual(['my-model.json', 'my-model.json']);
    expect(loaded.entities[0].relationships[0].to).toBe('Doc');
    expect(loaded.source).toBe('artifact');
  });

  it('rejects JSON without an entities array', () => {
    expect(() => parseModelArtifact('{"foo": 1}', 'x.json')).toThrow(/missing "entities"/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseModelArtifact('{not json', 'x.json')).toThrow(/Could not parse/);
  });
});

describe('parseMermaidErd', () => {
  const erd = `erDiagram
  ORGANIZATION ||--o{ PROJECT : "owns"
  PROJECT ||--o{ TASK : "contains"
  USER }o--o{ ORGANIZATION : "membership"
  PROFILE ||--|| USER : "has"
  ORGANIZATION {
    string id PK
    string name
  }
  AUDIT_LOG
`;

  it('parses entities, cardinalities, and labels', () => {
    const model = parseMermaidErd(erd, 'schema.mmd');

    expect(model).not.toBeNull();
    const names = model!.entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['ORGANIZATION', 'PROJECT', 'TASK', 'USER', 'PROFILE', 'AUDIT_LOG']));

    const org = model!.entities.find((e) => e.name === 'ORGANIZATION')!;
    expect(org.relationships).toContainEqual({ to: 'PROJECT', kind: 'hasMany', via: 'owns' });

    const user = model!.entities.find((e) => e.name === 'USER')!;
    expect(user.relationships).toContainEqual({ to: 'ORGANIZATION', kind: 'manyToMany', via: 'membership' });

    const profile = model!.entities.find((e) => e.name === 'PROFILE')!;
    expect(profile.relationships).toContainEqual({ to: 'USER', kind: 'hasOne', via: 'has' });
  });

  it('skips attribute block contents and cites the artifact as filePath', () => {
    const model = parseMermaidErd(erd, 'schema.mmd');

    expect(model!.entities.map((e) => e.name)).not.toContain('string');
    expect(model!.entities.every((e) => e.filePath === 'schema.mmd')).toBe(true);
  });

  it('synthesizes domains from connected components, with strays in Other', () => {
    const model = parseMermaidErd(erd, 'schema.mmd');

    // ORGANIZATION has the most edges → the connected component is named after it
    const hub = model!.domains.find((d) => d.name === 'ORGANIZATION');
    expect(hub).toBeDefined();
    expect(hub!.entities).toEqual(expect.arrayContaining(['ORGANIZATION', 'PROJECT', 'TASK', 'USER', 'PROFILE']));

    const other = model!.domains.find((d) => d.name === 'Other');
    expect(other!.entities).toEqual(['AUDIT_LOG']);
  });

  it('parses an erDiagram embedded in a markdown fence', () => {
    const md = ['# Our data model', '', '```mermaid', 'erDiagram', '  A ||--o{ B : "owns"', '```', 'trailing prose'].join(
      '\n',
    );
    const model = parseMermaidErd(md, 'README.md');

    expect(model!.entities.map((e) => e.name).sort()).toEqual(['A', 'B']);
  });

  it('returns null when there is no erDiagram', () => {
    expect(parseMermaidErd('graph TD\n A --> B', 'x.mmd')).toBeNull();
  });
});

describe('loadModelArtifact', () => {
  it('loads a Mermaid file from disk and errors on missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fga-artifact-'));
    try {
      const path = join(dir, 'model.mmd');
      await writeFile(path, 'erDiagram\n  ORG ||--o{ APP : "owns"\n');

      const model = await loadModelArtifact(path);
      expect(model.entities.map((e) => e.name).sort()).toEqual(['APP', 'ORG']);

      await expect(loadModelArtifact(join(dir, 'nope.json'))).rejects.toThrow(/Could not read/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unrecognized formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fga-artifact-'));
    try {
      const path = join(dir, 'notes.txt');
      await writeFile(path, 'just some prose about our app');
      await expect(loadModelArtifact(path)).rejects.toThrow(/Unrecognized model artifact format/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
