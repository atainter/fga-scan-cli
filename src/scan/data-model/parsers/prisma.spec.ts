import { describe, it, expect } from 'vitest';
import { parsePrismaSchema } from './prisma.js';

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  ADMIN
  MEMBER
}

model Organization {
  id       String       @id @default(cuid())
  name     String
  projects Project[]
  members  Membership[]
}

model Project {
  id    String @id @default(cuid())
  name  String
  org   Organization @relation(fields: [orgId], references: [id])
  orgId String
  tasks Task[]
  tags  Tag[]
}

model Task {
  id        String  @id
  project   Project @relation(fields: [projectId], references: [id])
  projectId String
}

model Tag {
  id       String    @id
  projects Project[]
}

model User {
  id          String       @id
  memberships Membership[]
  profile     Profile?
}

model Profile {
  id     String @id
  user   User   @relation(fields: [userId], references: [id])
  userId String @unique
}

model Membership {
  id     String       @id
  user   User         @relation(fields: [userId], references: [id])
  userId String
  org    Organization @relation(fields: [orgId], references: [id])
  orgId  String
  role   Role
}
`;

describe('parsePrismaSchema', () => {
  const discovery = parsePrismaSchema([{ path: 'prisma/schema.prisma', content: SCHEMA }])!;

  it('extracts all models with file evidence (enums are not entities)', () => {
    expect(discovery).not.toBeNull();
    expect(discovery.entities.map((e) => e.name).sort()).toEqual([
      'Membership', 'Organization', 'Profile', 'Project', 'Tag', 'Task', 'User',
    ]);
    expect(discovery.entities.every((e) => e.filePath === 'prisma/schema.prisma')).toBe(true);
  });

  it('derives belongsTo from @relation(fields:)', () => {
    const project = discovery.entities.find((e) => e.name === 'Project')!;
    expect(project.relationships).toContainEqual({ to: 'Organization', kind: 'belongsTo', via: 'orgId' });

    const task = discovery.entities.find((e) => e.name === 'Task')!;
    expect(task.relationships).toContainEqual({ to: 'Project', kind: 'belongsTo', via: 'projectId' });
  });

  it('derives hasOne when the FK scalar is @unique', () => {
    const profile = discovery.entities.find((e) => e.name === 'Profile')!;
    expect(profile.relationships).toContainEqual({ to: 'User', kind: 'hasOne', via: 'userId' });
  });

  it('derives implicit many-to-many from list fields on both sides', () => {
    const project = discovery.entities.find((e) => e.name === 'Project')!;
    expect(project.relationships).toContainEqual({ to: 'Tag', kind: 'manyToMany' });
  });

  it('keeps the membership join model as an entity (it carries a role)', () => {
    const membership = discovery.entities.find((e) => e.name === 'Membership')!;
    expect(membership.relationships).toContainEqual({ to: 'User', kind: 'belongsTo', via: 'userId' });
    expect(membership.relationships).toContainEqual({ to: 'Organization', kind: 'belongsTo', via: 'orgId' });
  });

  it('synthesizes domains and returns null for non-schema content', () => {
    expect(discovery.domains.length).toBeGreaterThan(0);
    expect(parsePrismaSchema([{ path: 'x.prisma', content: 'not a schema' }])).toBeNull();
  });
});
