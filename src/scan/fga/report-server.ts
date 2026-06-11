import { Hono } from 'hono';
import { serve } from '@hono/node-server';

export interface ReportServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Serve a generated report from memory on an ephemeral local port.
 * Nothing is written to disk — the page exists only while the CLI runs.
 */
export async function serveFgaReport(html: string, reportJson: string, port = 0): Promise<ReportServerHandle> {
  const app = new Hono();
  app.get('/', (c) => c.html(html));
  app.get('/report.json', (c) => c.body(reportJson, 200, { 'Content-Type': 'application/json' }));

  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
