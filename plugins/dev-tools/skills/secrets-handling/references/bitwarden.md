# Bitwarden

## Password vault (`bw`)

Unlock happens in the user's own terminal, never in chat:

1. The user runs `(umask 077; bw unlock --raw > <file>)`.
2. You run `bw --session "$(cat <file>)" …` and print only non-secret fields.
3. Finish with `bw lock` and delete the file.

Never export `BW_SESSION` in a profile. Do not install a Bitwarden MCP server: it has no read-only mode and gives an agent full vault access.

## Secrets Manager (`bws`)

- The access token lives in the OS keyring, not in a config file or the shell environment of your session. Look for the wrapper that injects it before reporting no access.
- Inject with `bws run -- <command>`.
- List names and counts (`bws secret list <project> --output json | jq 'map(.key)'`); fetch a value only to hand it straight to a process, never to display it.
- Names that are not valid variable names need renaming before they can be injected as env vars.

## Keyring through a dotfiles manager

chezmoi stores and reads keyring entries with `chezmoi secret keyring set` and the `keyring` template function, so a rendered config gets the token without it ever being committed.

## Verify

CLI flags and policies change; check [Bitwarden Secrets Manager CLI](https://bitwarden.com/help/secrets-manager-cli/) before relying on a flag you have not used.
