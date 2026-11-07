# Operators and controllers

## Reconciler contract

- The input is a key (namespace/name), not an event: re-read the object, compute the desired state, converge. Running twice changes nothing the second time.
- Create-or-update with `controllerutil.CreateOrUpdate` or server-side apply under your field manager; mutate only fields you own, or every reconcile fights other writers and re-triggers itself. Never delete-and-recreate.
- Set an owner reference (`controllerutil.SetControllerReference`) on everything you create, and `Owns(...)` it in `SetupWithManager`, so garbage collection and watches work.
- Write `status` through the status subresource only; compare before updating to avoid hot loops. No volatile data (timestamps) in status.
- Errors: return them for backoff; `RequeueAfter` for polling an external system; never `time.Sleep`.

```go
// +kubebuilder:rbac:groups=billing.acme.io,resources=invoices,verbs=get;list;watch
// +kubebuilder:rbac:groups=billing.acme.io,resources=invoices/status,verbs=get;update;patch
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list;watch;create;update;patch
func (r *InvoiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error)
func (r *InvoiceReconciler) SetupWithManager(mgr ctrl.Manager) error // For(&Invoice{}).Owns(&corev1.ConfigMap{})
```

RBAC markers generate the ClusterRole: keep them minimal and re-run `make manifests`.

## Status conditions

- `status.conditions []metav1.Condition` with `Ready` (and `Progressing` or `Degraded` when useful); set `observedGeneration`; update with `meta.SetStatusCondition`.
- `reason` is CamelCase and stable (it is API); `message` is for humans.

## Finalizers

Only for cleanup of something outside the cluster. Add on first reconcile; on deletion run idempotent cleanup, then remove it; treat a missing external resource as success. A stuck finalizer blocks namespace deletion.

## API and CRD versions

- Start `v1alpha1`; one storage version; a served version is never removed while objects of it are stored.
- Multiple versions: one hub, spokes convert to and from it (controller-runtime `Hub` and `Convertible`), conversion round-trips losslessly (annotation for dropped fields), conversion webhook deployed before the new version is served.
- Additive changes only within a version; renames and semantic changes need a new version.
- Validate in the schema (`+kubebuilder:validation`, CEL `x-kubernetes-validations`) before a webhook.

## Test tiers

| Tier | Tool | Runs | Covers |
|---|---|---|---|
| Unit | plain Go with a fake client | every commit | pure desired-state functions, condition logic |
| envtest | real API server and etcd, no kubelet | every PR | reconcile against the API, CRD schema, owner references, finalizers |
| End-to-end | kind cluster, built image, chart | merge queue or nightly | install, upgrade from the previous release, RBAC as shipped |

envtest has no controller-manager: assert owner references instead of garbage collection, and use a unique namespace per test (namespaces never finish deleting). Make targets: `test`, `test-envtest`, `test-e2e`.
