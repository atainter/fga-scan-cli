import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';

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

  // Wait for the "listening" callback before reading the port. serve() binds
  // asynchronously, so reading server.address() synchronously returns null and
  // the URL ends up as :0 (port 0 = "let the OS pick a free port"). The
  // listener gives the real assigned port.
  let server!: ServerType;
  const actualPort = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => resolve(info.port));
  });

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
