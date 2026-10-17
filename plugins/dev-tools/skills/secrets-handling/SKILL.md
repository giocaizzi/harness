---
name: secrets-handling
description: Handling secrets safely with any vault or password manager (Bitwarden bw/bws, 1Password, pass, cloud secret managers), OS keyrings and encrypted config - never printed, never inlined, never stored in plaintext. Use when a task touches credentials, tokens, API keys, .env files, a keyring, a vault or password manager, or secret injection.
---

# Secrets handling

A secret that appears in chat, a log, shell history, a commit or a command line is compromised: output is cached, indexed and shared. Handle secrets so their values never reach your output at all.

## Rules

- **Never print a value.** Not in chat, logs, PR text, commit messages, or `echo`/`cat`/`env` output. Filter results to names, counts or match/no-match.
- **Never inline.** No secrets in command arguments, URLs, source, config committed to a repo, or `export` lines in shell profiles. Arguments land in process lists and history.
- **Keyring or credential manager only.** Store and read through the OS store: macOS Keychain, Windows Credential Manager, Linux Secret Service. Never a plaintext file or an env var set by hand.
- **Inject, don't read.** Give the process its secret through the environment at launch (the vault CLI's `run`/`exec` wrapper) instead of fetching the value and passing it along.
- **Wrapper first.** Before asking the user for a token or reporting that you lack access, look for an existing wrapper that injects it from the keyring (a shell function or alias, a task-runner target, the private agent instructions) and run that. A token absent from your environment is not a token you cannot use.
- **Unlock in the user's terminal.** An interactive unlock or login happens there, never in chat. Never ask for a master password or a session token.
- **Least privilege.** One machine account or service token per machine, read-only, scoped to one project, with an expiry date. No vault MCP server or integration that grants an agent full vault access.
- **Encrypted at rest in repos.** Files that must be committed are encrypted (age, sops). Public repos hold no plaintext secrets, ever.
- **If a value leaked, rotate it.** Deleting the message or commit is not enough.

## Vault specifics

- [references/bitwarden.md](references/bitwarden.md): read when using the Bitwarden CLIs (`bw` password vault, `bws` Secrets Manager) or storing a token in a keyring through a dotfiles manager.

For any other vault, apply the rules above to its CLI and check its docs before relying on a flag you have not used.
