---
section: Fixed
issues: [1068]
---
- Adding people to or removing people from a static or snapshot audience now locks each person's profile row and follows them to their surviving profile under that lock, so a merge that commits while the call is in flight can no longer leave a membership row on a merged-away id that no send, estimate or membership read ever sees. The command no longer holds a workspace-wide lock, so other writes in the workspace are not held up.
- The audience's Segment Entered and Segment Exited events now go through the transactional outbox as the new `segment_change` kind, published after the change commits. When the bus is down they wait in the outbox: `am doctor` reports them under `queue.outbox`, and `am outbox --kind segment_change` requeues them.
