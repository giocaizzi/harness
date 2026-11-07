# Manifests

## Workload checklist

- [ ] `resources.requests` for cpu and memory; memory `limits` equal to the request; a CPU limit only with measured need.
- [ ] `startupProbe` for slow starts, `readinessProbe` for traffic, `livenessProbe` for a wedged process only (local check, no dependencies).
- [ ] Image `repo@sha256:<digest>`; `imagePullPolicy` left to the default or `IfNotPresent`.
- [ ] `securityContext` per [SECURITY.md](SECURITY.md); `automountServiceAccountToken: false` unless the pod calls the API.
- [ ] Replicas >= 2 for a served workload, with a PodDisruptionBudget and `topologySpreadConstraints` over `topology.kubernetes.io/zone` and `kubernetes.io/hostname`.
- [ ] Standard labels `app.kubernetes.io/name`, `instance`, `version`, `part-of`; selectors use only name and instance (selectors are immutable).
- [ ] `terminationGracePeriodSeconds` covers drain time; handle SIGTERM, use `preStop` only to delay endpoint removal.

## Skeleton (fields to set, not a template to copy)

```yaml
kind: Deployment
spec:
  replicas: 3
  strategy: {rollingUpdate: {maxUnavailable: 0, maxSurge: 1}}
  template:
    spec:
      serviceAccountName: orders        # one per workload
      topologySpreadConstraints: [{maxSkew: 1, topologyKey: topology.kubernetes.io/zone, whenUnsatisfiable: ScheduleAnyway, labelSelector: {}}]
      containers:
        - name: orders
          image: registry.example.com/acme/orders@sha256:<digest>
          resources: {requests: {cpu: 100m, memory: 256Mi}, limits: {memory: 256Mi}}
          startupProbe: {}
          readinessProbe: {}
          livenessProbe: {}
---
kind: PodDisruptionBudget
spec: {maxUnavailable: 1, selector: {}}   # never minAvailable == replicas
```

## Rollout

- `maxUnavailable: 0` with `maxSurge` keeps capacity; the surge pods need quota and node room.
- A stuck rollout: `kubectl rollout status`, then check readiness, quota and PDB before touching replicas.
- Roll back by redeploying the previous artifact through the pipeline, not `kubectl edit`.

## Apply

- Validate with `kubeconform -strict` (plus CRD schemas) before merge; `kubectl diff --server-side` in review.
- CI or GitOps applies with `kubectl apply --server-side` under a named field manager; `--force-conflicts` only on purpose.
- Prune what you delete (GitOps prune or `--prune` with a label selector); orphaned objects keep running.
