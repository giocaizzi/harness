# Naming and filing convention

## Grammar

`<scope>-<system>-<kind>[-<qualifier>][-<env>]`

| Part | Meaning | Examples |
|---|---|---|
| scope | owner of the secret: a GitHub org or user, a product, a host | `acme`, `acme-labs`, `homelab`, `storefront` |
| system | what it authenticates to | `github`, `cloudflare`, `gcp`, `postgres`, `anthropic` |
| kind | one of the list below | `api-token`, `app`, `ssh-key` |
| qualifier | which one: machine, repo, purpose, service | `laptop`, `release-please`, `workers-deploy` |
| env | only when several exist; none means a single or prod environment | `dev`, `prod` |

## Kinds

`app` (GitHub App), `pat`, `api-token`, `api-key`, `client-id`, `client-secret`, `oauth-secret`, `webhook-secret`, `encryption-key`, `headers`, `password`, `ssh-key`, `deploy-key`, `signing-key`, `tls-key`, `tls-cert`, `service-account`, `license`, `ui-login`.

Add a kind only when none fits and the owner agrees; a new kind goes in this list in the same change.

## Examples

| Before | After |
|---|---|
| `GITHUB_SSH_KEY_ME` | `acme-github-ssh-key-laptop` |
| `db_pw_admin_dev` | `acme-postgres-password-admin-dev` |
| `[dev] TF_VAR_API_TOKEN` | `acme-cloudflare-api-token-dev` |
| `release_please_pem` | `acme-github-app-release-please` |
| `Grafana UI` | `homelab-grafana-ui-login` |

## Folders

`Personal/<area>` (accounts, unchanged), `Work/<employer>` (kept separate from everything else), `Dev/github-apps`, `Dev/cloud`, `Dev/ai`, `Dev/signing` (SSH, deploy, signing keys), `Dev/<host or product>` (one folder per host or product, not per service), `_archive` (superseded or dead, reviewed later). Folder names are lowercase kebab-case below `Dev`.

## GitHub App item

One secure note per App (so a rename of the App is one item), named `<owner>-github-app-<purpose>`:

- fields: `app-id`, `client-id`, `slug`, `owner`, `purpose`, `installed-on` (repos or orgs), `callback-url`, hidden `client-secret`, hidden `webhook-secret`;
- attachment: `<slug>.<YYYY-MM-DD>.private-key.pem`; a regenerated key is a new attachment, and the old one is removed once nothing uses it;
- the note body holds no secret text, only a short human description.

A personal access token is `<owner>-github-pat-<purpose>`, a login-type item with the expiry in a field.
