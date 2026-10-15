# Release flow and manual release

## The release flow

1. Developers land Conventional Commits on the default branch.
2. The `release-please` workflow runs on each push and opens/updates a Release PR titled `chore(release): X.Y.Z` (`chore(main): release X.Y.Z` in monorepos). The PR body previews the changelog and version bumps.
3. Reviewers inspect the PR.
   - Do not push commits to the Release PR branch; release-please overwrites them.
   - If something is wrong, fix the underlying commits on `main` and let release-please re-render the PR.
4. Merging the PR is the release. release-please then:
   - updates `.release-please-manifest.json`
   - updates every tracked version file (the native one plus everything in `extra-files`)
   - rewrites `CHANGELOG.md`
   - creates tag `vX.Y.Z` (`<package>-vX.Y.Z` in monorepos)
   - publishes a GitHub Release pointing at that tag
5. Downstream workflows triggered by the `v*` tag (Docker build, npm/PyPI publish, deployment) take over.

Do not hand-edit `CHANGELOG.md`; add manual notes through release-please-supported inputs.

## Manual release

Last resort. The manifest must end up consistent with the tag. Before starting, check `extra-files` so every tracked version location is updated.

```bash
# 1. Set the same version in the manifest and every tracked version file.
# 2. Update CHANGELOG.md by hand.
# 3. Tag and create the GitHub Release.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```

After the next merge to `main`, verify release-please reads the manifest correctly and opens a fresh Release PR.

## Maintenance line

Patch `X.Y` (for example a `3.1.1` hotfix) while `main` is on a later minor or major.

1. **Cut the branch from the release tag:** `git branch release/X.Y.x vX.Y.0 && git push origin release/X.Y.x`.
2. **Run release-please on it, on that branch only.** In its copy of the release-please workflow, trigger on `push: branches: [main, "release/**"]` and pass `target-branch: ${{ github.ref_name }}` to `googleapis/release-please-action`. It then keeps its own Release PR and patch line there; the manifest on the release branch carries the patch version and `main`'s manifest is untouched.
3. **Run CI on PRs into the line.** The CI workflow's `pull_request.branches` filter must include `release/**` on both `main` and the release branch: a PR's workflow comes from its base branch.
4. **Land the fix** as a `fix:` PR into `release/X.Y.x`. release-please opens `chore(release): X.Y.(Z+1)` there; merging it tags `vX.Y.(Z+1)` and the tag-triggered CD runs as usual.
5. **Port the fix to `main`** as its own PR (cherry-pick, Conventional Commit title), unless `main` already has it.
6. **Retire the line** when no longer supported: delete the branch; the tags keep the commits.

Gotchas:

- **Protection:** a ruleset scoped to `main` does not cover `release/**`. Decide explicitly whether the line needs the same required checks, and add the pattern to the ruleset if so.
- **Tags:** a repo without components keeps bare `vX.Y.Z` tags on both lines, so versions must never collide: the line only ever bumps the patch of `X.Y`.
- **"Latest" release:** GitHub marks a newly published release as latest unless told otherwise, so a maintenance release can take over the badge from `main`'s newer one. After it publishes, check with `gh release view` and restore with `gh release edit <main's newest tag> --latest`.
- **Container `:latest`:** a CD workflow that tags the image `latest` on every `v*` tag (e.g. docker/metadata-action `type=raw,value=latest,enable=startsWith(github.ref,'refs/tags/v')`) moves `:latest` back to the maintenance build, and anything deploying `:latest` rolls back. Re-run CD for `main`'s newest tag (`gh workflow run <cd workflow> --ref vA.B.C`), or enable `latest` only when the tag is the highest.
