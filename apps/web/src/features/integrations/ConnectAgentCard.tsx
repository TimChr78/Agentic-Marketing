import { CodeView } from '../../ui';

/** How to connect an MCP client: the URL, OAuth (recommended) or an API token. */
export function ConnectAgentCard() {
  return (
    <div className="space-y-3 text-[13px]">
      <p className="max-w-[70ch] leading-5 text-muted">
        Agents use the same commands as this UI, under the same rules: they draft, people approve. Choose a brand and only the permissions
        the agent needs.
      </p>
      <CodeView value={`${location.origin}/mcp`} label="MCP server URL" />
      <p className="text-fg-2">
        Clients that support OAuth (Claude, ChatGPT and others) sign in as you and ask which scopes to grant. Others send an API token from
        this page as <code className="font-mono text-[12px]">Authorization: Bearer amk_…</code>. REST works the same at{' '}
        <code className="font-mono text-[12px]">{location.origin}/v1/&lt;command&gt;</code> (OpenAPI at{' '}
        <a className="text-accent underline" href="/openapi.json">
          /openapi.json
        </a>
        ).
      </p>
    </div>
  );
}
