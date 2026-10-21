import { serve } from '@hono/node-server';
import { config } from './config';
import { createApp } from './app';
import { migrate } from './db/migrate';

await migrate();
serve({ fetch: createApp().fetch, port: config.port }, () => {
  console.log(`spike listening on ${config.baseUrl}  (REST /v1/*, OpenAPI /openapi.json, MCP /mcp)`);
});
