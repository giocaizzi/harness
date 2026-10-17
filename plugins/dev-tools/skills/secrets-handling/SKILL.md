---
name: secrets-handling
description: Handling secrets safely with Bitwarden (bw, bws), OS keyrings and encrypted config - never printed, never inlined, never stored in plaintext. Use when a task touches credentials, tokens, API keys, .env files, a password manager or secret injection.
---

# Secrets handling

A secret that appears in chat, a log, shell history, a commit or a command line is compromised: output is cached, indexed and shared. Handle secrets so their values never reach your output at all.

## Rules

- **Never print a value.** Not in chat, logs, PR text, commit messages, or `echo`/`cat`/`env` output. Filter results to names, counts or match/no-match.
- **Never inline.** No secrets in command arguments, URLs, source, config committed to a repo, or `export` lines in shell profiles. Arguments land in process lists and history.
- **Keyring or credential manager only.** Store and read through the OS store: macOS Keychain, Windows Credential Manager, Linux Secret Service (for chezmoi: `chezmoi secret keyring set`). Never a plaintext file or an env var set by hand.
- **Inject, don't read.** Give the process its secret through the environment at launch (for example `bws run -- <command>`) instead of fetching the value and passing it along.
- **Least privilege.** One machine account per machine, read-only, scoped to one project, with an expiry date.
- **Encrypted at rest in repos.** Files that must be committed are age-encrypted. Public repos hold no plaintext secrets, ever.
- **If a value leaked, rotate it.** Deleting the message or commit is not enough.

## Bitwarden CLI (`bw`, password vault)

Unlock happens in the user's own terminal, never in chat:

1. The user runs `(umask 077; bw unlock --raw > <file>)`.
2. You run `bw --session "$(cat <file>)" …` and print only non-secret fields.
3. Finish with `bw lock` and delete the file.

Never ask for the master password or a session token, and never export `BW_SESSION` in a profile. Do not install a Bitwarden MCP server: it has no read-only mode and gives an agent full vault access.

## Secrets Manager CLI (`bws`)

- The access token lives in the OS keyring, not in a config file or the shell environment of your session.
- Before asking the user for a token or reporting that you lack access, look for an existing wrapper that injects it from the keyring (a shell function or alias, a task-runner target, the private agent instructions) and run that. A token absent from your environment is not a token you cannot use.
- List names and counts (`bws secret list <project> --output json | jq 'map(.key)'`); fetch a value only to hand it straight to a process, never to display it.
- Names that are not valid variable names need renaming before they can be injected as env vars.

## Verify

CLI flags and policies change; check [Bitwarden Secrets Manager CLI](https://bitwarden.com/help/secrets-manager-cli/) before relying on a flag you have not used.
