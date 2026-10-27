/** What an MCP client gets in `initialize` and as the `agentic-marketing://guide` resource. */
export const MCP_INSTRUCTIONS = `Agentic Marketing is an agent-first marketing platform. You draft artifacts; depending on the workspace policy, a person reviews and publishes them.

Start with workspace.get (workspace, approval policy, time zone, your permissions and what each lets you do) and artifacts.types with a type, e.g. {"type":"email_template"}. Omitting type returns every schema and is large. Read the type's schema before creating content.

Artifacts are versioned: create with artifacts.create, edit with artifacts.updateDraft, inspect with artifacts.get, artifacts.list, artifacts.diff and artifacts.history. Validate and simulate before asking to publish: segments.preview, templates.preview, smsTemplates.preview, pushTemplates.preview, broadcasts.preview, journeys.simulate and prompts.test.

Run templates.check before requestPublish for an e-mail and fix what it finds; blocking findings stop the publish.

To see the real e-mail in an inbox before asking for review, templates.sendTest and broadcasts.sendTest send a [Test] copy to workspace members or the admin's seed list (no one else).

Publishing: call artifacts.requestPublish with a note for the reviewer. It submits the latest draft for review under the workspace approval policy and publishes directly only when the policy allows it (none, or agent_changes for a person's own edits). The result says what happened: reviewUrl links to the approval in the admin UI and next says what to do; while it is in review, a person approves or rejects it there. Requests are per artifact, or per bundle (below). Agents cannot approve or reject (approvals.approve and approvals.reject are people-only), and sending needs messages:send, which agent tokens usually are not granted. As an agent under agent_changes you do not publish yourself: submit, then check approvals.list or artifacts.get for the result. Agents cannot change workspace settings but can propose the name and time zone with workspace.proposeUpdate; a person approves it.

Dependencies: a double opt-in form needs its confirmation e-mail template, a broadcast its template and segment, a journey its referenced templates, segments and prompts. When the prerequisites are drafts too, submit them together with artifacts.requestPublishBundle {artifactIds, note}: one review for all of them, references between them are checked as if published, and approval publishes them in dependency order in one step (rejecting rejects all). Use artifacts.requestPublish when the prerequisites are already published.

Weekly newsletters use the template-per-issue pattern: one e-mail template per issue. Broadcasts have no per-send data, so a shared layout template cannot be filled with each issue's content. For every issue, create a new email_template (copy the previous issue's template as a starting point) and a broadcast that references it, then submit both with artifacts.requestPublishBundle: the reviewer sees the e-mail, the audience and the send time in one request. Keep the header, footer and other repeated parts in email_block artifacts: templates include them with {% block 'blk_…', title: 'This week' %} (blocks.usage shows where a block is used, and a new block can be published in the same bundle as its template).

Privacy and consent: segments cannot use personal traits (email, phone, name, birthday, address, ...); use non-personal traits, events and consent instead. Sends only reach people who consented to the purpose. Keep the unsubscribe link and purpose on e-mail templates.

Tool errors explain what to fix; fix the input and try again. This guide is also available as the resource agentic-marketing://guide.`;

export const MCP_GUIDE_URI = 'agentic-marketing://guide';
