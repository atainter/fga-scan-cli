import { describe, it, expect } from 'vitest';
import { parseDrizzleSnapshot } from './drizzle-snapshot.js';

const SNAPSHOT = JSON.stringify({
  version: '7',
  dialect: 'postgresql',
  tables: {
    'public.organizations': {
      name: 'organizations',
      schema: '',
      columns: {
        id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true },
        name: { name: 'name', type: 'text', primaryKey: false, notNull: true },
      },
      foreignKeys: {},
      compositePrimaryKeys: {},
      uniqueConstraints: {},
    },
    'public.projects': {
      name: 'projects',
      schema: '',
      columns: {
        id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true },
        org_id: { name: 'org_id', type: 'uuid', primaryKey: false, notNull: true },
      },
      foreignKeys: {
        projects_org_id_fk: {
          name: 'projects_org_id_fk',
          tableFrom: 'projects',
          tableTo: 'organizations',
          columnsFrom: ['org_id'],
          columnsTo: ['id'],
        },
      },
      compositePrimaryKeys: {},
      uniqueConstraints: {},
    },
    'public.profiles': {
      name: 'profiles',
      schema: '',
      columns: {
        id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true },
        user_id: { name: 'user_id', type: 'uuid', primaryKey: false, notNull: true },
      },
      foreignKeys: {
        profiles_user_id_fk: {
          name: 'profiles_user_id_fk',
          tableFrom: 'profiles',
          tableTo: 'users',
          columnsFrom: ['user_id'],
          columnsTo: ['id'],
        },
      },
      compositePrimaryKeys: {},
      uniqueConstraints: {
        profiles_user_id_unique: { name: 'profiles_user_id_unique', columns: ['user_id'] },
      },
    },
    'public.users': {
      name: 'users',
      schema: '',
      columns: {
        id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true },
      },
      foreignKeys: {},
      compositePrimaryKeys: {},
      uniqueConstraints: {},
    },
  },
});

describe('parseDrizzleSnapshot', () => {
  const discovery = parseDrizzleSnapshot('drizzle/meta/0003_snapshot.json', SNAPSHOT)!;

  it('extracts tables and FK relationships from the snapshot JSON', () => {
    expect(discovery).not.toBeNull();
    expect(discovery.entities.map((e) => e.name).sort()).toEqual([
      'organizations', 'profiles', 'projects', 'users',
    ]);
    const projects = discovery.entities.find((e) => e.name === 'projects')!;
    expect(projects.relationships).toContainEqual({ to: 'organizations', kind: 'belongsTo', via: 'org_id' });
  });

  it('derives hasOne from a unique constraint on the FK column', () => {
    const profiles = discovery.entities.find((e) => e.name === 'profiles')!;
    expect(profiles.relationships).toContainEqual({ to: 'users', kind: 'hasOne', via: 'user_id' });
  });

  it('returns null for malformed snapshots', () => {
    expect(parseDrizzleSnapshot('x.json', 'not json')).toBeNull();
    expect(parseDrizzleSnapshot('x.json', '{"no": "tables"}')).toBeNull();
  });
});
