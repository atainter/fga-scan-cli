import { describe, it, expect } from 'vitest';
import { parsePostgresSql, parseMysqlSql } from './sql.js';

const MIGRATION_1 = `
CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id)
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text UNIQUE
);

-- pure join table: folds into manyToMany
CREATE TABLE project_tags (
  project_id uuid NOT NULL REFERENCES projects(id),
  tag_id uuid NOT NULL REFERENCES tags(id),
  PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  label text
);
`;

const MIGRATION_2 = `
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE
);
ALTER TABLE profiles ADD CONSTRAINT profiles_user_fk FOREIGN KEY (user_id) REFERENCES users(id);

-- membership carries a role: stays an entity
CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  role text NOT NULL
);

CREATE OR REPLACE FUNCTION exotic_thing() RETURNS trigger AS $$
BEGIN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

describe('parsePostgresSql', () => {
  const discovery = parsePostgresSql([
    { path: 'migrations/001_init.sql', content: MIGRATION_1 },
    { path: 'migrations/002_more.sql', content: MIGRATION_2 },
  ])!;

  it('folds DDL across migration files into entities', () => {
    expect(discovery).not.toBeNull();
    const names = discovery.entities.map((e) => e.name).sort();
    expect(names).toEqual(['memberships', 'organizations', 'profiles', 'projects', 'tags', 'users']);
  });

  it('derives belongsTo from inline REFERENCES', () => {
    const projects = discovery.entities.find((e) => e.name === 'projects')!;
    expect(projects.relationships).toContainEqual({ to: 'organizations', kind: 'belongsTo', via: 'org_id' });
  });

  it('derives hasOne from ALTER TABLE FK on a UNIQUE column', () => {
    const profiles = discovery.entities.find((e) => e.name === 'profiles')!;
    expect(profiles.relationships).toContainEqual({ to: 'users', kind: 'hasOne', via: 'user_id' });
  });

  it('folds the pure join table into manyToMany and drops it as an entity', () => {
    expect(discovery.entities.find((e) => e.name === 'project_tags')).toBeUndefined();
    const projects = discovery.entities.find((e) => e.name === 'projects')!;
    expect(projects.relationships).toContainEqual({ to: 'tags', kind: 'manyToMany', via: 'project_tags' });
  });

  it('keeps the role-carrying membership table as an entity', () => {
    const memberships = discovery.entities.find((e) => e.name === 'memberships')!;
    expect(memberships.relationships).toContainEqual({ to: 'users', kind: 'belongsTo', via: 'user_id' });
    expect(memberships.relationships).toContainEqual({ to: 'organizations', kind: 'belongsTo', via: 'org_id' });
  });

  it('survives exotic statements (function bodies) without losing tables', () => {
    expect(discovery.entities.length).toBe(6);
  });

  it('returns null when nothing parses', () => {
    expect(parsePostgresSql([{ path: 'x.sql', content: 'this is not sql at all' }])).toBeNull();
  });
});

describe('parseMysqlSql', () => {
  it('parses MySQL DDL via the dbml importer', async () => {
    const discovery = await parseMysqlSql([
      {
        path: 'migrations/001.sql',
        content: `
CREATE TABLE orgs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE apps (
  id INT PRIMARY KEY AUTO_INCREMENT,
  org_id INT NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);
`,
      },
    ]);

    expect(discovery).not.toBeNull();
    expect(discovery!.entities.map((e) => e.name).sort()).toEqual(['apps', 'orgs']);
    const apps = discovery!.entities.find((e) => e.name === 'apps')!;
    expect(apps.relationships).toContainEqual({ to: 'orgs', kind: 'belongsTo', via: 'org_id' });
  });
});
