---
name: kubernetes
description: "Use when writing or changing Kubernetes manifests, a Helm chart or values, a kustomize overlay, a CRD, RBAC, a controller or operator, pods that get OOMKilled, or a rollout to a cluster."
---

# Kubernetes

Category: infrastructure operations. Cluster state comes from reviewed files applied by CI or GitOps; the defaults below are what a reviewer checks first.

Scope: manifests, Helm charts and values, Kustomize overlays, CRDs, RBAC, NetworkPolicy, controllers and operators (kubebuilder, controller-runtime) and rollouts.

## Opinions

1. Every workload sets resource requests and limits, and liveness, readiness and startup probes. Readiness gates traffic, liveness restarts: never point liveness at a dependency. See [MANIFESTS.md](references/MANIFESTS.md).
2. Every container runs non-root, with a read-only root filesystem, `allowPrivilegeEscalation: false` and `drop: [ALL]`. See [SECURITY.md](references/SECURITY.md).
3. A replicated service gets a PodDisruptionBudget and topology spread constraints.
4. Images are pinned by digest (tag kept for humans); never `latest`.
5. Secrets come from a secret manager or external-secrets, never from committed manifests or values files.
6. RBAC is least privilege: one ServiceAccount per workload, namespaced Roles, no `cluster-admin`. Namespaces start with a default-deny NetworkPolicy.
7. Pick Helm or Kustomize per deployable, not both. Helm: one chart per deployable, logic-light templates, `values.schema.json`, `helm lint` and `helm template | kubeconform` as make targets, chart tests. See [HELM.md](references/HELM.md).
8. The same artifact (image digest, chart version) is promoted across environments; only values or overlays differ.
9. Changes reach shared clusters from CI or GitOps, never a hand `kubectl apply` (same principle as Terraform). Prefer server-side apply. The pipeline side (build once, promote by digest, one deploy per environment at a time, a GitOps commit of the new digest) is `ci-cd`.
10. Operators: idempotent reconcile, status conditions, owner references, finalizers only for external cleanup, versioned and conversion-safe CRDs, tests in tiers with the heavy tier in the merge queue or nightly. See [OPERATORS.md](references/OPERATORS.md).

## Gotchas

- Helm installs `crds/` once and never updates or deletes them on upgrade: ship CRD changes through a separate apply step or chart.
- Client-side `kubectl apply` stores the manifest in the `last-applied-configuration` annotation, capped at 256 KiB total annotation size: big CRDs and ConfigMaps fail, use `--server-side`.
- Server-side apply tracks field ownership: a second manager changing an owned field gets a conflict, and a controller and a human fighting over a field is a reconcile loop.
- A liveness probe that checks a database restarts healthy pods when the database blips.
- An omitted tag means `latest`, which defaults `imagePullPolicy` to `Always`; a digest defaults to `IfNotPresent`.
- A CPU limit throttles a container even when the node has free CPU: set a memory limit equal to the request and think twice before a CPU limit.
- A PDB with `minAvailable` equal to replicas, or one pod already unready, blocks node drains and stalls rollouts.
- envtest runs no controllers other than your own: no garbage collection (assert owner references instead) and no namespace deletion.

## References

Load only what the task needs.

- [MANIFESTS.md](references/MANIFESTS.md): workload skeleton and checklist, rollout settings.
- [HELM.md](references/HELM.md): chart layout, make targets, CRDs, Kustomize choice.
- [OPERATORS.md](references/OPERATORS.md): reconciler skeleton, conditions, finalizers, API versions, test tiers.
- [SECURITY.md](references/SECURITY.md): securityContext, RBAC, NetworkPolicy, secrets checklist.
