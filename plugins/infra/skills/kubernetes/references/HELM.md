# Helm and Kustomize

## Choose

One tool per deployable. Helm for software shipped to others or needing real parameters; Kustomize for in-house apps whose environments differ by patches. Do not post-process Helm output with Kustomize unless a vendored chart forces it.

## Chart checklist

- [ ] One chart per deployable; umbrella charts only for a release unit that always ships together.
- [ ] `values.yaml` documents every key; `values.schema.json` (JSON Schema) rejects unknown or mistyped keys (`additionalProperties: false`).
- [ ] Templates logic-light: no business rules, a helper per repeated block in `_helpers.tpl`, `required` for mandatory values, `toYaml | nindent` for passthrough blocks.
- [ ] Image set as `repository` plus `digest`; defaults satisfy [MANIFESTS.md](MANIFESTS.md) and [SECURITY.md](SECURITY.md).
- [ ] No secret values in `values*.yaml`; reference an existing Secret or an ExternalSecret.
- [ ] Chart tests under `templates/tests/` (hook `helm.sh/hook: test`) run in the kind tier; `helm-unittest` when templates hold logic.
- [ ] Chart `version` bumped on every change, `appVersion` is the app release; publish to an OCI registry.
- [ ] Per-environment files differ only in scale, hosts and resource sizes.

## Make targets

```make
helm-lint:     ## schema + lint
	helm lint charts/orders --strict -f charts/orders/ci/values.yaml
helm-validate: ## render and validate against API schemas
	helm template orders charts/orders -f charts/orders/ci/values.yaml | kubeconform -strict -summary -
helm-test:     ## needs a kind cluster
	helm upgrade --install orders charts/orders --wait && helm test orders
```

`check` depends on `helm-lint helm-validate`.

## CRDs

- `crds/` is installed once; Helm never upgrades or deletes it, and `--dry-run` skips it.
- Ship CRDs that change as a separate chart or a pipeline step applied before the release (server-side apply), and version them with the API.
- CRDs under `templates/` update on upgrade, but uninstalling the release deletes every custom resource: avoid for shared CRDs.

## Kustomize

- `base/` holds the artifact once; `overlays/<env>/` patch only scale, hosts, sizes and config references.
- Patches target by name (strategic merge or JSON 6902); images change through `images:` with digests, set by the pipeline.
- Make target: `kustomize build overlays/<env> | kubeconform -strict -summary -`.
