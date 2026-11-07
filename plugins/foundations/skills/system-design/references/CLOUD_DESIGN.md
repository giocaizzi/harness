# Cloud design

## Managed vs self-hosted

| Prefer managed when | Self-host only when |
|---|---|
| The service is not your differentiator | A hard requirement (feature, compliance, latency) managed cannot meet |
| The team has no on-call capacity for it | A measured cost gap justifies the operational load |
| A standard API exists (Postgres, object storage, queue) | You can name the owner, upgrade and backup procedure |

Record the choice in an ADR with the monthly cost of both.

## Checklist

| Area | Decide |
|---|---|
| Regions | primary region, residency limits; multi-region only if RTO/RPO or latency numbers require it; zone redundancy |
| IAM | one identity per workload; least privilege with resource-scoped policies; no long-lived keys (workload identity or roles); no wildcard action or resource |
| Network edges | only the load balancer or gateway is public; data in private subnets; egress allow-list; TLS everywhere; private endpoints to managed services |
| Secrets | secret manager, rotation; never in images, git or logs |
| Data | encryption at rest and in transit, backups with a tested restore, retention, deletion path |
| Scaling | autoscaling signal and upper bound, quotas checked, cold start acceptable? |
| Observability | logs, metrics, traces and SLO alerts defined before launch |
| Cost | monthly estimate at steady and peak, per-unit cost, budget alert, ownership tags, egress and cross-zone traffic counted |
| Exit | what moving off would cost; lock-in accepted knowingly |

## Cost as an NFR

State a ceiling, estimate from the NFR volumes with the provider's calculator, alert at 80%, review monthly. Common hidden items: data egress, NAT gateways, idle always-on instances, log ingestion, cross-region replication.
