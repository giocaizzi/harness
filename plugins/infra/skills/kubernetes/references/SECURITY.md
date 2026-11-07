# Security

## Pod securityContext (meets the `restricted` Pod Security Standard)

```yaml
spec:
  securityContext: {runAsNonRoot: true, seccompProfile: {type: RuntimeDefault}}
  containers:
    - securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
```

- Writable paths are `emptyDir` mounts, never the root filesystem.
- Label namespaces `pod-security.kubernetes.io/enforce: restricted`; relax per namespace with a recorded reason.
- No `privileged`, `hostNetwork`, `hostPath` or `hostPID` in application workloads.

## RBAC checklist

- [ ] One ServiceAccount per workload; no use of `default`.
- [ ] Namespaced `Role` and `RoleBinding`; a `ClusterRole` only for cluster-scoped resources (and operators).
- [ ] Named verbs and resources; no `*`; `resourceNames` when the set is known.
- [ ] No `cluster-admin` binding to a workload or to CI; CI deploys with a scoped role.
- [ ] `secrets` read access only to the workload that needs them; `escalate`, `bind` and `impersonate` never granted.
- [ ] Check with `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`.

## NetworkPolicy

- Per namespace: a default-deny policy for ingress and egress, then one allow policy per flow (DNS egress, ingress from the gateway, the datastore).
- The CNI must enforce NetworkPolicy; a policy on a non-enforcing CNI is silent.

## Secrets

- The secret manager is the source of truth; an `ExternalSecret` (external-secrets) or the CSI driver materialises it. Manifests carry only names.
- Prefer mounted files over env vars; enable encryption at rest on the cluster.
- A secret that reached git is rotated, not deleted.
- Scan manifests and values for secrets (`gitleaks`) in CI.
