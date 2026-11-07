# Go: depguard and an architecture test

## depguard per layer

Add one rule per layer next to the `house` rule in the go skill's `.golangci.yml` (`linters.settings.depguard.rules`). `files` are globs; `!$test` keeps the rule off test files, which may wire layers together. `list-mode` defaults to `original`: with only a `deny` list, everything not denied is allowed.

```yaml
linters:
  settings:
    depguard:
      rules:
        # house: keep the existing rule here.
        domain-pure:
          files:
            - "**/internal/domain/**"
            - "!$test"
          deny:
            - pkg: acme/app/internal/db
              desc: the domain declares the interface it needs; internal/db implements it and main wires it
            - pkg: acme/app/internal/api
              desc: imports go down only (api > service > domain); move the shared code into the domain
            - pkg: database/sql
              desc: persistence belongs in internal/db behind a domain interface
        service-no-api:
          files:
            - "**/internal/service/**"
            - "!$test"
          deny:
            - pkg: acme/app/internal/api
              desc: services never import the transport layer; return values and let api translate
```

Each `desc` is the instruction: what to do instead and where it lives. An entry is a string prefix, or an exact match when it ends with `$`. List an exception as an `allow` entry with a comment giving the reason, never as a wider `files` exclusion.

## arch_test.go for what depguard cannot say

Use it for transitive rules (a layer must not depend on a package through another one) or counting rules. Read `go list -deps` and filter to the module's own path, since the output includes the standard library.

```go
package arch_test

import (
	"os/exec"
	"strings"
	"testing"
)

const module = "acme/app/"

// internalDeps returns the module's own packages that pkg depends on, directly or not.
func internalDeps(t *testing.T, pkg string) []string {
	t.Helper()
	out, err := exec.Command("go", "list", "-deps", pkg).Output()
	if err != nil {
		t.Fatalf("go list -deps %s: %v", pkg, err)
	}
	var internal []string
	for _, p := range strings.Fields(string(out)) {
		if strings.HasPrefix(p, module) {
			internal = append(internal, p)
		}
	}
	return internal
}

func TestDomainDoesNotReachDB(t *testing.T) {
	for _, d := range internalDeps(t, "./internal/domain") {
		if strings.HasPrefix(d, module+"internal/db") {
			t.Errorf("domain depends on %s: declare an interface in domain and implement it in internal/db", d)
		}
	}
}
```

It runs with the normal `go test ./...`, so `make test` carries it.
