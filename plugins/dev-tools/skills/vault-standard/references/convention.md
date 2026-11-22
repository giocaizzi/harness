# Naming and filing standard

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

`<context>/<system or product>`, plus `_archive` for superseded or dead items awaiting review. Contexts belong to the owner (for example `personal`, `work/<employer>`, `dev`), and work stays separate from everything else. Below a context, one folder per system or product, not per service or item: `dev/cloud`, `dev/ai`, `dev/signing` (SSH, deploy and signing keys), `dev/<product>`. Folder names are lowercase kebab-case. Human accounts keep whatever area folders they already have.

## Multi-part item

A credential made of several parts (a service account, an OAuth client, an app with an id, a secret and a key file) is one secure note, so a rename or rotation touches one item:

- fields: the non-secret identifiers (`client-id`, `account-id`, `slug`), `owner`, `purpose`, `consumers` (what holds a copy), `expires`; hidden fields for each secret part (`client-secret`, `webhook-secret`);
- attachment: the key file, named `<id>.<YYYY-MM-DD>.<what>`; a regenerated key is a new attachment, and the old one is removed once nothing uses it;
- the note body holds no secret text, only a short human description.

A single token or key is a login-type item with the value in the password field and `expires` in a field. Example: a GitHub App is `<owner>-github-app-<purpose>` with fields `app-id`, `client-id`, `slug`, `installed-on`, `callback-url`.
