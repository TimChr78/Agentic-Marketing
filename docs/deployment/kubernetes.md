# Kubernetes reference deployment

The Helm chart in [`deploy/helm/agentic-marketing`](../../deploy/helm/agentic-marketing) runs the one image as four Deployments, one per role (ADR-0002), and a migration Job:

| Role | Serves | Scale |
|---|---|---|
| `api` | UI, REST, MCP, copilot, e-mail links and provider webhooks | 2+ replicas, by request rate |
| `ingest` | `/v1/*` (events, decide, consent purposes), `/f/*` signup forms, `/hooks/in/*` | 2+ replicas; optional CPU autoscaling |
| `worker` | ClickHouse sink, profile workers, journeys, AI steps, deliveries | 2+ replicas; consumers share work through NATS and `SKIP LOCKED` claims |
| `scheduler` | segment refreshes, broadcasts, retention, token refresh, audience sync, spend import, warehouse exports, edge sync, threshold alerts, held agent changes, agent notifications and events, hosted agents, content sources, segment enrollment jobs | exactly 1 (`Recreate`) |

The Ingress sends the public collection paths to `ingest` and everything else to `api`. The Job runs `cli migrate` (Postgres, auth tables, ClickHouse and its row policies) as a **pre-install/pre-upgrade** hook: before any role Deployment exists on a first install and before the new ReplicaSets roll on an upgrade. The roles start with `SKIP_MIGRATIONS=true`, because the hook has already migrated the database before they start.

The hook cannot rely on the release's ConfigMap and Secret: Helm runs pre-install hooks before it creates them. It therefore takes its configuration from the chart's `config` values and its secret values from `secrets.existingSecret` (which must exist) or from a temporary hook Secret rendered from `secrets.values`. `extraEnv` and `extraVolumes` are also passed to the hook, so any Secret or ConfigMap they reference must already exist in the namespace on a first install. The chart-created ServiceAccount also appears after the hook; the migration uses the namespace's default ServiceAccount and needs no API access (set `serviceAccount.create=false` if a cluster requires a specific existing ServiceAccount for image pulls).

This ordering is what makes `helm install --wait` safe: Helm waits for the migration hook, then creates the roles and waits for them, and never waits on a readiness probe of a pod that is itself waiting for a post-install job. A failed migration fails the install or upgrade before the roles are created or rolled. With `--atomic`, Helm rolls the release back, but the database schema is forward-only: restore a Postgres backup rather than expecting the schema to roll back with the release.

If the platform is reached through a tunnel or proxy that should see only the public paths, set `PUBLIC_PORT` (e.g. `3001`) on the `api` and `ingest` roles: the server adds a listener that serves only `/f`, `/u`, `/c`, `/a`, `/n`, `/hooks`, `/healthz` and `/readyz`. The chart does not publish a second Service port, so expose it through your own Service/Ingress or keep the path split above. Both listeners reject raw dot-segment and encoded-separator paths with 400, so a loose proxy rule cannot reach the admin API.

Postgres, ClickHouse, NATS JetStream and Valkey are not in the chart. Use managed services or the operators you already run (CloudNativePG, the Altinity ClickHouse operator, the NATS Helm chart with JetStream, Valkey or Redis).

## Install

```bash
kubectl create secret generic am-secrets \
  --from-literal=DATABASE_URL='postgres://am:…@postgres:5432/am' \
  --from-literal=APP_DB_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=AUTH_SECRET="$(openssl rand -base64 32)" \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)"

helm install am deploy/helm/agentic-marketing \
  --set secrets.existingSecret=am-secrets \
  --set config.PUBLIC_URL=https://marketing.example.com \
  --set config.CLIENT_IP_HEADER=x-forwarded-for \
  --set config.TRUSTED_PROXY_CIDRS=10.244.0.0/16 \
  --set config.CLICKHOUSE_URL=http://am:…@clickhouse:8123 \
  --set ingress.enabled=true --set ingress.host=marketing.example.com \
  --wait --atomic
```

`--wait` is supported precisely because migrations are a pre-install hook (see above). `--atomic` rolls the release back if a role does not become ready; it does not undo the schema migration, so take a Postgres backup before the upgrade (the chart's hook runs `cli migrate`, not a backup). For upgrades use the same flags with `helm upgrade`; the pre-upgrade hook migrates with the new values before any role rolls.

The chart uses the released image, `ghcr.io/timchr78/agentic-marketing:<appVersion>`; the packaged chart is also attached to each [GitHub release](https://github.com/TimChr78/Agentic-Marketing/releases). For your own build, push it to your registry and set `image.repository` and `image.tag`.

## Client IP behind the Ingress

The server rate-limits sign-in and public endpoints per client IP. Behind the Ingress the socket peer is the ingress controller, and the client IP arrives in a forwarding header. Set `config.TRUSTED_PROXY_CIDRS` to the ranges the app sees as its peer; the chart refuses to render with `ingress.enabled=true` and an empty list, because with an empty list the forwarding header is ignored, every client is seen as the ingress controller and per-client rate limits collapse into one shared bucket.

`resolveClientIp` walks a multi-value header such as `x-forwarded-for` from right to left, skipping addresses inside `TRUSTED_PROXY_CIDRS`, and returns the first address outside them. An appending proxy (nginx's default `proxy_add_x_forwarded_for`) leaves a client-supplied prefix in place, so the rightmost untrusted address is the real client. A single-value header that the controller overwrites (`cf-connecting-ip`, `x-real-ip`) is used as-is.

Find the ranges:

```bash
# Where the controller runs, and the addresses it connects from.
kubectl get pods -n ingress-nginx -l app.kubernetes.io/component=controller -o wide
# On a cluster where that output shows node IPs (hostNetwork), list the node network instead.
kubectl get nodes -o wide
```

With ingress-nginx and most in-cluster controllers, the app sees the controller pod's IP, so use the cluster pod network (for example `10.244.0.0/16`, or `--cluster-cidr` from your CNI). A controller with `hostNetwork: true`, or a cloud load balancer that connects from its own subnet, reaches the app from the node or load-balancer range: use that CIDR instead. Include the loopback ranges only if something in the pod calls the app directly. Do not use `0.0.0.0/0`: it trusts every peer again.

```yaml
config:
  CLIENT_IP_HEADER: x-forwarded-for   # the header your controller sets; an ordered list if it sets several
  TRUSTED_PROXY_CIDRS: 10.244.0.0/16  # the ingress controller pod (or node/load-balancer) range
```

Check the result with `am doctor` in a pod: the `trusted-proxy-cidrs` row must be `ok`, not the empty-list warning.

Then create the first workspace with `cli bootstrap` (the chart's notes print the command). `DATABASE_URL` is an owner of the database: migrations create the `am_app` role that the application itself uses under row-level security.

## Keys: MASTER_KEY, OpenBao or AWS KMS

Secrets (provider API keys, OAuth tokens) and personal data are encrypted with per-workspace data keys; a key-encryption key (KEK) wraps those. `KEY_PROVIDER` says where the KEK lives:

- `local`: `MASTER_KEY` in the environment (the default, fine for a single host).
- `openbao`: OpenBao or HashiCorp Vault [Transit](https://openbao.org/docs/secrets/transit/). The KEK never leaves OpenBao.
  ```bash
  bao secrets enable transit
  bao write -f transit/keys/agentic-marketing
  bao policy write agentic-marketing - <<'P'
  path "transit/encrypt/agentic-marketing" { capabilities = ["update"] }
  path "transit/decrypt/agentic-marketing" { capabilities = ["update"] }
  P
  ```
  Set `OPENBAO_ADDR` and either `OPENBAO_TOKEN` or `OPENBAO_TOKEN_FILE` (written by an OpenBao agent sidecar or a projected secret; the file is re-read when the token is rejected). Optional: `OPENBAO_TRANSIT_MOUNT`, `OPENBAO_TRANSIT_KEY`, `OPENBAO_NAMESPACE`. Rotate the Transit key in OpenBao as often as you like (`bao write -f transit/keys/agentic-marketing/rotate`); old versions still decrypt.
- `aws-kms`: a symmetric AWS KMS key (`AWS_KMS_KEY_ID`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN` and `AWS_KMS_ENDPOINT` for a VPC endpoint). The IAM principal needs `kms:Encrypt` and `kms:Decrypt` on that key. Static or session credentials only for now; pod identity (IRSA) needs a credentials helper that exports them.

Unwrapped data keys are cached in memory for ten minutes, so the KEK is called about once per data key and interval, not per request.

**Moving from `MASTER_KEY`:** set `KEY_PROVIDER` and its settings while keeping `MASTER_KEY`. Data keys wrapped by the local key keep working, and new ones are wrapped by the provider. Run `cli rotate-keys` once to re-wrap every existing data key, then remove `MASTER_KEY` (and `MASTER_KEY_PREVIOUS`).

**Rolling out a Secret change.** The pod template carries a `checksum/secret` annotation. With `secrets.values` the rendered Secret is part of that hash, so a changed value rolls the four Deployments on `helm upgrade`. Helm cannot read a `secrets.existingSecret` (sealed-secrets, External Secrets, Vault agent, a manual `kubectl create secret`), so changing that object in place does not change the pod template and the running pods keep the old environment. After changing it, bump `secrets.revision` in the same upgrade, for example:

```bash
helm upgrade am deploy/helm/agentic-marketing --reuse-values \
  --set secrets.revision="$(date +%F)" --wait --atomic
```

Alternatively, run `kubectl rollout restart deploy/am-agentic-marketing-api deploy/am-agentic-marketing-ingest deploy/am-agentic-marketing-worker deploy/am-agentic-marketing-scheduler` (use your release name). Do one of these for every Secret-only rotation, including `MASTER_KEY`, `METRICS_TOKEN` and a `KEY_PROVIDER` switch; otherwise the rotation silently does not take effect until the next unrelated rollout.

## Sizing

Measured with `cli loadtest` on one 4-vCPU, 16 GB machine with everything on it (see the [wave 2 roadmap](../architecture/roadmap-wave-2.md#phase-10-scale-and-operations-the-original-phase-6)): 1M profiles refresh a segment in 2 to 34 seconds; the scheduler peaked at about 1.1 GB during a first refresh that moved 500,000 people. A starting point:

| Profiles | Postgres | ClickHouse | NATS | Valkey | App |
|---|---|---|---|---|---|
| up to 100k | 2 vCPU, 4 GB | 2 vCPU, 4 GB | 1 node | 256 MB | one replica per role |
| 1M | 4 vCPU, 16 GB | 4 vCPU, 16 GB | 3 nodes, JetStream R3 | 1 GB | as in `values.yaml` |
| 10M | 8+ vCPU, 32+ GB, fast disk | 8+ vCPU, 32+ GB | 3 nodes | 4 GB | scheduler limit 4 GB; more ingest and workers |

10M is an estimate from the 1M run, not a measurement yet. Keep the NATS volume on encrypted storage (events hold personal traits until processed; `NATS_RETENTION_HOURS`, 24 by default).
