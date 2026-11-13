# Pre-releases, and when a release goes wrong

## Pre-releases and release candidates

- A pre-release carries a SemVer pre-release suffix (`2.0.0-rc.1`, `-beta.2`) and is published to a channel users opt into: npm dist-tag `next`, a PyPI pre-release (pip skips it without `--pre`), a GitHub release marked pre-release, a store's beta or TestFlight track.
- Use one when a release needs real users before it is final: a major version, a migration, a new platform. Each candidate that passes becomes the final version unchanged, apart from the suffix.
- A pre-release never takes the latest marker or the default channel.

## A release that went wrong

Decide by what is broken, not by how fast a revert feels.

| What happened | Do |
|---|---|
| The publish failed and nothing reached users | Re-run the publish for the missing parts; the tag stays. |
| A broken version reached users | Ship the fix as the next version. Then yank or deprecate the broken one: npm `npm deprecate <pkg>@<v> "<why>"` (unpublish only within the registry's window and only if nothing depends on it), PyPI yank, crates.io `cargo yank`, a GitHub release edited to say so. |
| The wrong version number was released | Leave it published and correct it with the next release; record why in its notes. |
| The tag points at the wrong commit and nothing was published from it | Delete the tag and its release, fix the cause, tag again. Once anything was published from it, it stays. |
| A secret was shipped in an artifact | Rotate the secret first (`secrets-handling`), then yank and ship a clean version: a yanked artifact stays downloadable. |
| A store build is bad | Halt its staged rollout, ship a new build with a higher build number: [store-apps.md](store-apps.md). |

Write down what failed and the fix in the next release's notes, so users who hit it know which version to take.
