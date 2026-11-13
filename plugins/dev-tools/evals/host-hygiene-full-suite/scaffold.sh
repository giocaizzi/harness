#!/usr/bin/env bash
# A repo whose Makefile has a test target and an emulator test target.
set -euo pipefail
cat > Makefile <<'MK'
.PHONY: test test-emulator

test:
	./gradlew test

test-emulator:
	./gradlew connectedAndroidTest
MK
printf '#!/usr/bin/env sh\necho "gradle $@"\n' > gradlew
chmod +x gradlew
printf '# app\n' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
