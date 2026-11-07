# Testing

The local gate needs no credentials, state or lock. Expose each step as a make target (`fmt`, `validate`, `lint`, `test`) and have `check` run them all.

| Step | Command |
|---|---|
| Format | `terraform fmt -check -recursive` |
| Validate | `terraform init -backend=false`, then `terraform validate`, per root and module |
| Lint | `tflint --recursive` |
| Module tests | `terraform test` in each module (OpenTofu: `tofu test`) |

## Module tests

- Files are `*.tftest.hcl` in the module (its root or `tests/`), made of `run` blocks with `assert` blocks.
- Use `command = plan` so nothing is created; the default `command = apply` creates real resources.
- Use `mock_provider "<name>" {}` so no credentials are needed. Mocks generate values for computed attributes; set known values with `mock_resource` / `mock_data` `defaults`, or `override_resource` / `override_data` / `override_module` for one object.
- Computed values are unknown at plan time. Assert on attributes derived from inputs, or set `override_during = plan` on the mock so generated values exist in a plan-only run.
- Test the rules: variable `validation` failures with `expect_failures`, tag and name conventions, `for_each` keys, `prevent_destroy` presence.
- Test state lives in memory per test file, so a configured backend is not used; still run `init -backend=false` first so the directory is initialized (the docs do not say `test` skips the backend itself).
- Variables a test needs go in the file-level `variables` block or a `run`-level one.
