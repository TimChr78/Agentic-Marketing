import { Card, CodeView } from '../../ui';

/** How to connect an MCP client: the URL, OAuth (recommended) or an API token. */
export function ConnectAgentCard() {
  return (
    <Card title="Connect an agent" description="Agents use the same commands as this UI, under the same rules: they draft, people approve.">
      <div className="space-y-3 p-4 text-[13px]">
        <CodeView value={`${location.origin}/mcp`} label="MCP server URL" />
        <p className="text-fg-2">
          Clients that support OAuth (Claude, ChatGPT and others) sign in as you and ask which scopes to grant. Others send an API token
          from this page as <code className="font-mono text-[12px]">Authorization: Bearer amk_…</code>. REST works the same at{' '}
          <code className="font-mono text-[12px]">{location.origin}/v1/&lt;command&gt;</code> (OpenAPI at{' '}
          <a className="text-accent hover:underline" href="/openapi.json">
            /openapi.json
          </a>
          ).
        </p>
      </div>
    </Card>
  );
}
