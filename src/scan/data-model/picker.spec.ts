import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockIsCancel = vi.fn();
vi.mock('../../utils/clack.js', () => ({
  default: {
    select: (...args: unknown[]) => mockSelect(...args),
    isCancel: (...args: unknown[]) => mockIsCancel(...args),
  },
}));

import { promptForDomain } from './picker.js';
import type { DataModelDiscovery } from './types.js';

const outline: DataModelDiscovery = {
  source: 'prisma',
  summary: 'A multi-tenant app.',
  entities: [
    { name: 'Project', filePath: 'prisma/schema.prisma', relationships: [] },
    { name: 'Invoice', filePath: 'prisma/schema.prisma', relationships: [] },
  ],
  domains: [
    { name: 'Projects', description: 'Project tracking', entities: ['Project'] },
    { name: 'Billing', entities: ['Invoice'] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCancel.mockReturnValue(false);
});

describe('promptForDomain', () => {
  it('offers "whole application" plus one option per domain', async () => {
    mockSelect.mockResolvedValue('__all__');
    await promptForDomain(outline);

    const options = mockSelect.mock.calls[0][0].options as { value: string }[];
    expect(options.map((o) => o.value)).toEqual(['__all__', 'Projects', 'Billing']);
  });

  it('returns scope "all" when the whole application is chosen', async () => {
    mockSelect.mockResolvedValue('__all__');
    expect(await promptForDomain(outline)).toEqual({ mode: 'all' });
  });

  it('returns a single-domain scope when a domain is chosen', async () => {
    mockSelect.mockResolvedValue('Billing');
    expect(await promptForDomain(outline)).toEqual({ mode: 'domains', domains: ['Billing'] });
  });

  it('returns null when the user cancels', async () => {
    mockSelect.mockResolvedValue(Symbol('cancel'));
    mockIsCancel.mockReturnValue(true);
    expect(await promptForDomain(outline)).toBeNull();
  });
});
