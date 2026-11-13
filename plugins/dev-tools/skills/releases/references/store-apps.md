# Mobile, desktop and store apps

A store-distributed app has two numbers, and they do different jobs:

| Number | iOS / macOS | Android | Rule |
|---|---|---|---|
| Marketing version, shown to users | `CFBundleShortVersionString` | `versionName` | `MAJOR.MINOR.PATCH` by user-visible change, or the release train's CalVer; set in the release PR |
| Build number, read by the store | `CFBundleVersion` | `versionCode` | strictly increases on every upload; taken from CI (the run number, or a counter the pipeline owns), never typed by hand |

- **Release train.** Releases leave on a fixed cadence: what has landed by the cut is in, the rest waits for the next train. A fix found during review goes into the same release as a new build.
- **No rollback.** A store cannot return users to an older build. Ship through a staged rollout (Play staged rollout, App Store phased release), watch crash and error rates, halt the rollout on a regression, and roll forward with a new build.
- **Server compatibility.** Old app versions stay in use for months: the backend keeps serving every version it still supports (`api-design`), and a minimum supported version the app checks at start forces the update when that is unavoidable.
- **Review is part of the release.** Store review takes time and can reject a build: leave room for it in the train, and keep the release notes and metadata in the repo next to the code.
- **Signing keys are release infrastructure.** Upload and signing keys live in the pipeline's secret store (`secrets-handling`), never on a laptop; losing an Android upload key without Play App Signing means a new app listing.
- Tooling (fastlane, Gradle Play Publisher, Xcode Cloud) runs from the release tag in the pipeline like any other publish job (`ci-cd`).
