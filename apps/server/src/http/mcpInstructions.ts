/** What an MCP client gets in `initialize` and as the `agentic-marketing://guide` resource. */
export const MCP_INSTRUCTIONS = `Agentic Marketing is an agent-first marketing platform. You draft artifacts; depending on the workspace policy, a person reviews and publishes them.

Start with workspace.get (workspace, approval policy, time zone, your permissions and what each lets you do) and artifacts.types with a type, e.g. {"type":"email_template"}. Omitting type returns every schema and is large. Read the type's schema before creating content.

Artifacts are versioned: create with artifacts.create, edit with artifacts.updateDraft, inspect with artifacts.get, artifacts.list, artifacts.diff and artifacts.history. Validate and simulate before asking to publish: segments.preview, templates.preview, smsTemplates.preview, pushTemplates.preview, broadcasts.preview, journeys.simulate and prompts.test.

To see the real e-mail in an inbox before asking for review, templates.sendTest and broadcasts.sendTest send a [Test] copy to workspace members or the admin's seed list (no one else).

Publishing: call artifacts.requestPublish with a note for the reviewer. It submits the latest draft for review under the workspace approval policy and publishes directly only when the policy allows it (none, or agent_changes for a person's own edits). The result says what happened: reviewUrl links to the approval in the admin UI and next says what to do; while it is in review, a person approves or rejects it there. Requests are per artifact. Agents cannot approve or reject (approvals.approve and approvals.reject are people-only), and sending needs messages:send, which agent tokens usually are not granted. As an agent under agent_changes you do not publish yourself: submit, then check approvals.list or artifacts.get for the result.

Dependencies publish in rounds. A double opt-in form needs its confirmation e-mail template published; a broadcast needs its template and segment published; a journey's referenced templates, segments and prompts must be published. Publish the prerequisites first, then request the dependent artifact.

Weekly newsletters use the template-per-issue pattern: one e-mail template per issue. Broadcasts have no per-send data, so a shared layout template cannot be filled with each issue's content. For every issue, create a new email_template (copy the previous issue's template as a starting point), then a broadcast that references it. The broadcast can only be requested after the template is published, so an issue normally takes two approval rounds: template, then broadcast.

Privacy and consent: segments cannot use personal traits (email, phone, name, birthday, address, ...); use non-personal traits, events and consent instead. Sends only reach people who consented to the purpose. Keep the unsubscribe link and purpose on e-mail templates.

Tool errors explain what to fix; fix the input and try again. This guide is also available as the resource agentic-marketing://guide.`;

export const MCP_GUIDE_URI = 'agentic-marketing://guide';
