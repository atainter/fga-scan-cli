import { describe, it, expect } from 'vitest';
import { serveFgaReport } from './report-server.js';

describe('serveFgaReport', () => {
  it('binds a real ephemeral port (never :0) and serves the report', async () => {
    const handle = await serveFgaReport('<html>report</html>', '{"ok":true}');
    try {
      // Regression guard: reading the port too early yields 0 → http://127.0.0.1:0.
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

      const html = await fetch(handle.url).then((r) => r.text());
      expect(html).toContain('<html>report</html>');

      const json = await fetch(`${handle.url}/report.json`).then((r) => r.json());
      expect(json).toEqual({ ok: true });
    } finally {
      await handle.close();
    }
  });
});
