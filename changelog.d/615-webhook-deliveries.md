---
section: Fixed
issues: [580, 615]
---
- Webhooks → Recent deliveries and each endpoint's "Last delivery" now read only webhook deliveries. Busy connector-action or ad-conversion traffic can no longer fill the delivery cap and make a working endpoint show "Never".
- The read-only demo now also disables controls whose handler names are camelCase (`onDelete`, `doDelete`, `mutateRoleNow`, `applyTopic`, `changeTopic`) instead of letting them fail with the demo's refusal message.
