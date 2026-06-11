import { describe, it, expect } from 'vitest';
import { buildDiscoveryPrompt, buildDomainOutlinePrompt, type DiscoveryPromptContext } from './discovery-prompt.js';

const baseContext: DiscoveryPromptContext = {
  language: { name: 'JavaScript/TypeScript' },
  framework: { name: 'Next.js', version: '14' },
  dataModelHints: { sources: [{ kind: 'prisma', files: ['prisma/schema.prisma'] }] },
};

describe('buildDomainOutlinePrompt', () => {
  it('asks for entities + domains but explicitly NOT relationships', () => {
    const prompt = buildDomainOutlinePrompt(baseContext);

    expect(prompt).toContain('FAST first pass');
    expect(prompt).toContain('prisma/schema.prisma');
    // The cheap outline must not request relationships (that is the deep pass).
    expect(prompt).toContain('Do NOT include a "relationships" field');
    expect(prompt).not.toContain('"relationships": [');
  });

  it('discourages crawling the whole repo', () => {
    expect(buildDomainOutlinePrompt(baseContext)).toContain('do NOT crawl the whole repository');
  });
});

describe('buildDiscoveryPrompt', () => {
  it('requests relationships in the full (unfocused) pass', () => {
    const prompt = buildDiscoveryPrompt(baseContext);
    expect(prompt).toContain('"relationships"');
    expect(prompt).not.toContain('## Focus');
  });

  it('narrows to the focus entities when focusEntities is set', () => {
    const prompt = buildDiscoveryPrompt({ ...baseContext, focusEntities: ['Project', 'Task'] });

    expect(prompt).toContain('## Focus');
    expect(prompt).toContain('- Project');
    expect(prompt).toContain('- Task');
    expect(prompt).toContain('Do NOT inventory the rest of the model');
  });
});
