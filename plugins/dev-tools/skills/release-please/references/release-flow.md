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
