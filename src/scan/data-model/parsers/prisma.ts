import { getSchema, type Model, type Field, type Schema } from '@mrleebo/prisma-ast';
import { synthesizeDomains } from '../domains.js';
import { normalizeDiscovery } from '../parse.js';
import type { DataModelDiscovery, EntityRelationship } from '../types.js';

interface ParsedModel {
  name: string;
  filePath: string;
  fields: Field[];
}

function modelFields(model: Model): Field[] {
  return model.properties.filter((p): p is Field => p.type === 'field');
}

/** Extract a string[] from a prisma-ast attribute argument like `fields: [orgId]` */
function keyValueArray(field: Field, attributeName: string, key: string): string[] | null {
  const attribute = (field.attributes ?? []).find((a) => a.name === attributeName);
  if (!attribute) return null;
  for (const arg of attribute.args ?? []) {
    const value = arg.value as unknown as Record<string, unknown> | undefined;
    if (value && typeof value === 'object' && value.type === 'keyValue' && value.key === key) {
      const inner = value.value as Record<string, unknown> | undefined;
      if (inner && typeof inner === 'object' && inner.type === 'array' && Array.isArray(inner.args)) {
        return (inner.args as unknown[]).filter((a): a is string => typeof a === 'string');
      }
    }
  }
  return null;
}

function hasAttribute(field: Field, name: string): boolean {
  return (field.attributes ?? []).some((a) => a.name === name);
}

/**
 * Parse Prisma schema file(s) into a DataModelDiscovery. Relation semantics:
 *   - field with `@relation(fields: [...])` → belongsTo (hasOne when the FK
 *     scalar field is @unique)
 *   - list fields on BOTH sides with no `fields:` arg → implicit manyToMany
 *   - bare back-reference fields (the list side of a belongsTo) are implied
 *     and not emitted as separate edges
 */
export function parsePrismaSchema(files: { path: string; content: string }[]): DataModelDiscovery | null {
  const models: ParsedModel[] = [];

  for (const file of files) {
    let schema: Schema;
    try {
      schema = getSchema(file.content);
    } catch {
      continue; // unparseable file — others may still work
    }
    for (const block of schema.list) {
      if (block.type === 'model') {
        models.push({ name: block.name, filePath: file.path, fields: modelFields(block) });
      }
    }
  }

  if (models.length === 0) return null;

  const modelNames = new Set(models.map((m) => m.name));
  const modelsByName = new Map(models.map((m) => [m.name, m]));
  const relationshipsByModel = new Map<string, EntityRelationship[]>();
  const emittedM2M = new Set<string>();

  const addRelationship = (from: string, rel: EntityRelationship): void => {
    const list = relationshipsByModel.get(from) ?? [];
    if (!list.some((r) => r.to === rel.to && r.kind === rel.kind && r.via === rel.via)) {
      list.push(rel);
      relationshipsByModel.set(from, list);
    }
  };

  for (const model of models) {
    for (const field of model.fields) {
      const target = typeof field.fieldType === 'string' ? field.fieldType : null;
      if (!target || !modelNames.has(target)) continue;

      const fkColumns = keyValueArray(field, 'relation', 'fields');
      if (fkColumns && fkColumns.length > 0) {
        // FK side: belongsTo, or hasOne when the FK scalar is unique
        const fkFieldUnique =
          fkColumns.length === 1 &&
          model.fields.some((f) => f.name === fkColumns[0] && (hasAttribute(f, 'unique') || hasAttribute(f, 'id')));
        addRelationship(model.name, {
          to: target,
          kind: fkFieldUnique ? 'hasOne' : 'belongsTo',
          via: fkColumns.join('+'),
        });
        continue;
      }

      // Implicit many-to-many: list fields on both sides, neither with fields:
      if (field.array) {
        const counterpart = modelsByName
          .get(target)
          ?.fields.find(
            (f) => f.fieldType === model.name && f.array && !keyValueArray(f, 'relation', 'fields'),
          );
        if (counterpart) {
          const [a, b] = [model.name, target].sort();
          const pairKey = `${a}::${b}::${[field.name, counterpart.name].sort().join('/')}`;
          if (!emittedM2M.has(pairKey)) {
            emittedM2M.add(pairKey);
            addRelationship(a, { to: b, kind: 'manyToMany' });
          }
        }
      }
      // Non-list, no fields: → the back-reference side of a belongsTo/hasOne; implied
    }
  }

  const entities = models.map((m) => ({
    name: m.name,
    filePath: m.filePath,
    relationships: relationshipsByModel.get(m.name) ?? [],
  }));
  const edges = entities.flatMap((e) => e.relationships.map((r) => ({ from: e.name, to: r.to })));

  return normalizeDiscovery({
    source: 'prisma',
    summary: `Parsed deterministically from Prisma schema: ${entities.length} models, ${edges.length} relationships.`,
    entities,
    domains: synthesizeDomains(
      entities.map((e) => e.name),
      edges,
    ),
  });
}
