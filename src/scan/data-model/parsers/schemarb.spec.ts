import { describe, it, expect } from 'vitest';
import { parseSchemaRb } from './schemarb.js';

const SCHEMA_RB = `
ActiveRecord::Schema[7.1].define(version: 2026_01_01_000000) do
  enable_extension "plpgsql"

  create_table "organizations", force: :cascade do |t|
    t.string "name", null: false
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
  end

  create_table "projects", force: :cascade do |t|
    t.string "name"
    t.bigint "organization_id", null: false
    t.index ["organization_id"], name: "index_projects_on_organization_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "email"
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  create_table "profiles", force: :cascade do |t|
    t.bigint "user_id", null: false
    t.index ["user_id"], name: "index_profiles_on_user_id", unique: true
  end

  create_table "memberships", force: :cascade do |t|
    t.references "user", null: false, foreign_key: true
    t.bigint "organization_id", null: false
    t.string "role", null: false
  end

  create_table "projects_tags", id: false, force: :cascade do |t|
    t.bigint "project_id", null: false
    t.bigint "tag_id", null: false
  end

  create_table "tags", force: :cascade do |t|
    t.string "label"
  end

  add_foreign_key "projects", "organizations"
  add_foreign_key "profiles", "users"
  add_foreign_key "memberships", "organizations"
  add_foreign_key "projects_tags", "projects"
  add_foreign_key "projects_tags", "tags"
end
`;

describe('parseSchemaRb', () => {
  const discovery = parseSchemaRb('db/schema.rb', SCHEMA_RB)!;

  it('extracts tables from create_table blocks', () => {
    expect(discovery).not.toBeNull();
    const names = discovery.entities.map((e) => e.name).sort();
    expect(names).toEqual(['memberships', 'organizations', 'profiles', 'projects', 'tags', 'users']);
  });

  it('derives belongsTo from add_foreign_key with conventional column', () => {
    const projects = discovery.entities.find((e) => e.name === 'projects')!;
    expect(projects.relationships).toContainEqual({
      to: 'organizations',
      kind: 'belongsTo',
      via: 'organization_id',
    });
  });

  it('derives hasOne when the FK column has a unique index', () => {
    const profiles = discovery.entities.find((e) => e.name === 'profiles')!;
    expect(profiles.relationships).toContainEqual({ to: 'users', kind: 'hasOne', via: 'user_id' });
  });

  it('registers t.references with foreign_key: true', () => {
    const memberships = discovery.entities.find((e) => e.name === 'memberships')!;
    expect(memberships.relationships).toContainEqual({ to: 'users', kind: 'belongsTo', via: 'user_id' });
    expect(memberships.relationships).toContainEqual({
      to: 'organizations',
      kind: 'belongsTo',
      via: 'organization_id',
    });
  });

  it('folds the habtm join table into manyToMany', () => {
    expect(discovery.entities.find((e) => e.name === 'projects_tags')).toBeUndefined();
    const projects = discovery.entities.find((e) => e.name === 'projects')!;
    expect(projects.relationships).toContainEqual({ to: 'tags', kind: 'manyToMany', via: 'projects_tags' });
  });

  it('returns null for non-schema content', () => {
    expect(parseSchemaRb('db/schema.rb', 'class Foo; end')).toBeNull();
  });
});
