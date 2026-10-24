import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { touchesApprovalLabel, badTitle, branchFacts, cmdClass, branchTargets, codexRules, evaluateCommand, evaluateEdit, evaluateRouting, evaluateSpawn, nativeAsk, opencodeAsks, pureRead, refFacts, regenerableName, regenFacts, removalTargets, shellEdit, tagFacts, unattendedSet, usageLevel, worktreeFacts } from './engine.mjs';
import { rules } from './rules.mjs';

const fresh = () => ({ reminded: new Set() });
const calm = { load1: 2, freeGb: 100 };

test('commit without the skill: deny once, then allow', () => {
  const state = fresh();
  const first = evaluateCommand({ command: 'git commit -m "feat: x"', state, host: calm, rules });
  assert.equal(first.action, 'deny');
  assert.match(first.reason, /conventional-commits/);
  assert.equal(evaluateCommand({ command: 'git commit -m "feat: x"', state, host: calm, rules }).action, 'allow');
});

test('a loaded skill (namespaced) satisfies the rule', () => {
  const r = evaluateCommand({ command: 'git commit -m "feat: x"', loadedSkills: new Set(['dev-tools:conventional-commits']), state: fresh(), host: calm, rules });
  assert.equal(r.action, 'allow');
});

test('any-of skills: /ship satisfies the commit rule', () => {
  const r = evaluateCommand({ command: 'git commit -m "feat: x"', loadedSkills: new Set(['ship']), state: fresh(), host: calm, rules });
  assert.equal(r.action, 'allow');
});

test('unrelated commands pass', () => {
  assert.equal(evaluateCommand({ command: 'ls -la', state: fresh(), host: calm, rules }).action, 'allow');
});

test('recursive delete is caught in every flag spelling, plain deletes are not (#80)', () => {
  for (const command of ['rm -rf build', 'rm -R build', 'rm --recursive build', 'rm -v -r build', 'rm -f --recursive build', 'rm --force -r build', 'RM -RF build'])
    assert.equal(evaluateCommand({ command, state: fresh(), host: calm, rules }).action, 'ask', command);
  for (const command of ['rm build.txt', 'rm -f build.txt', 'rm -v build.txt', 'rm --force build.txt', 'npm run rm-cache'])
    assert.notEqual(evaluateCommand({ command, state: fresh(), host: calm, rules }).action, 'ask', command);
  assert.deepEqual(removalTargets('rm -v --recursive /tmp/a', rules), ['/tmp/a']);
});

test('risky commands always ask, even after a reminder', () => {
  const state = fresh();
  for (const command of ['rm -rf build', 'git reset --hard HEAD~1', 'git push --force origin x', 'terraform apply']) {
    assert.equal(evaluateCommand({ command, state, host: calm, rules }).action, 'ask', command);
    assert.equal(evaluateCommand({ command, state, host: calm, rules }).action, 'ask', command);
  }
});

test('nativeAsk: only a plain command starting with a risky prefix is left to the harness prompt', () => {
  assert.equal(nativeAsk('rm -rf build/x', 'rm', rules), true);
  assert.equal(nativeAsk('  git reset --hard', 'reset', rules), true);
  assert.equal(nativeAsk('git push -f origin x', 'force', rules), true);
  for (const [c, rule] of [['git clean -fdx', 'clean'], ['git checkout -- .', 'discard'], ['git stash drop', 'stash'], ['git branch -D x', 'branch-delete'], ['git push --mirror', 'push-delete'], ['git rm -rf x', 'git-rm']])
    assert.equal(nativeAsk(c, rule, rules), true, c);
  for (const [command, rule] of [
    // Codex runs these without its prompt rules (it does not parse expansions): all ran unasked in review.
    ['rm -r $PWD/victim', 'rm'],
    ['rm -r victim*', 'rm'],
    ['rm -R "$PWD"/victim', 'rm'],
    ['rm -r vic\\tim', 'rm'],
    ['rm -r ~/x', 'rm'],
    ['rm -rf ~/x', 'rm'],
    ['git reset --hard $NOPE', 'reset'],
    ['git push --force origin $NOPE', 'force'],
    ['terraform apply $NOPE', 'terraform'],
    ["rm -r 'a b'", 'rm'],
    ['rm -r {a,b}', 'rm'],
    ['rm -r a?', 'rm'],
    ['rm -r x # y', 'rm'],
    ['rm -r\tx', 'rm'],
    ['cd x && rm -rf y', 'rm'], // another command first
    ['rm -rf y; ls', 'rm'],
    ['rm -rf $(pwd)', 'rm'],
    ['rm  -rf y', 'rm'], // double space: the harness matcher would not see the prefix
    ['FOO=1 rm -rf y', 'rm'],
    ['rm -rfv y', 'rm'],
    ['git push origin x --force', 'force'], // flag not in prefix position
    ['git -C x reset --hard', 'reset'], // a prompt rule cannot skip git's global options
    ['find . -delete', 'find'], // no prefixes
    ['git push origin --delete main', 'push-delete'], // only --mirror and --prune are prefixes
    ['gh pr merge 1 --admin', 'merge'], // no prefixes
  ])
    assert.equal(nativeAsk(command, rule, rules), false, command);
});

test('every prefix is risky under its own rule, and renders for Codex and opencode', () => {
  for (const r of rules.risky)
    for (const p of r.prefixes ?? []) assert.match(`${p.join(' ')} x`, new RegExp(r.match, 'i'), p.join(' '));
  assert.match(codexRules(rules), /^prefix_rule\(pattern = \["rm","-rf"\], decision = "prompt", justification = "guard: recursive delete"\)$/m);
  assert.equal(opencodeAsks(rules)['git reset --hard *'], 'ask');
});

test('telemetry false positives stay fixed: read-only release, ruleset and tag commands pass', () => {
  const skill = (command) => evaluateCommand({ command, state: fresh(), host: calm, rules }).rule;
  for (const c of ['cat release-please-config.json', 'git show origin/main:release-please-config.json', 'gh run list --workflow release-please.yml',
    'git tag', 'git tag -l', 'git tag --list "v*"', 'git tag --contains HEAD', 'git tag --sort=-v:refname', 'gh api repos/o/r/rulesets', 'gh api repos/o/r/branches/main/protection --jq .x'])
    assert.equal(skill(c), undefined, c);
  for (const [c, rule] of [['git tag v1.2.0', 'release'], ['git tag -a v1 -m x', 'release'], ['npx release-please release-pr --repo-url o/r', 'release'], ['npm version patch', 'release'],
    ['gh api -X PUT repos/o/r/branches/main/protection --input p.json', 'ruleset'], ['gh api repos/o/r/rulesets -f name=x', 'ruleset'], ['gh api --method DELETE repos/o/r/rulesets/1', 'gh-delete']])
    assert.equal(skill(c), rule, c);
});

test('--force-with-lease to a feature branch passes; plain force, + refspecs and main still ask', () => {
  const act = (command) => evaluateCommand({ command, state: fresh(), host: calm, rules }).action;
  for (const c of ['git push --force-with-lease', 'git push -q --force-with-lease origin feat/x', 'git push --force-with-lease=feat/x:abc123 origin feat/x', 'git push origin --follow-tags'])
    assert.equal(act(c), 'allow', c);
  for (const c of ['git push --force', 'git push -f origin x', 'git push -qf origin x', 'git push origin +feat/x', 'git push --force-with-lease origin main', 'git push --force-with-lease origin HEAD:master'])
    assert.equal(act(c), 'ask', c);
});

test('a recursive delete of a temp dir held in a variable or a quoted $TMPDIR path does not ask', () => {
  const env = { TMPDIR: '/var/folders/ab/T/' };
  const act = (command) => evaluateCommand({ command, state: fresh(), host: calm, env, rules }).action;
  for (const c of ['S=$(mktemp -d); do_x; rm -rf $S', 'T=$(mktemp -d -t probe) && rm -rf "$T"', 'rm -rf "$TMPDIR/x"', 'R=/private/tmp/claude-1/s/x; rm -rf $R/home', 'export E="$TMPDIR/e"; rm -rf ${E}'])
    assert.equal(act(c), 'allow', c);
  for (const c of ['S=$(mktemp -d foo.XXXX); rm -rf $S', 'S=build; rm -rf $S', 'rm -rf $S', 'S=$(mktemp -d); rm -rf $S/..', 'S=$(mktemp -d); rm -rf $S /', 'rm -rf "$HOME/x"'])
    assert.equal(act(c), 'ask', c);
});

test('a glob in the last segment of a temp path does not ask; one at the temp root or a dot glob does', () => {
  const env = { TMPDIR: '/var/folders/ab/T/' };
  const act = (command) => evaluateCommand({ command, state: fresh(), host: calm, env, rules }).action;
  for (const c of ['rm -rf /private/tmp/claude-1/p/s/scratchpad/*', 'rm -rf /tmp/x/run-?.log', 'S=$(mktemp -d); rm -rf $S/*', 'rm -rf "$TMPDIR/x"/*'])
    assert.equal(act(c), 'allow', c);
  for (const c of ['rm -rf /tmp/*', 'rm -rf $TMPDIR/*', 'rm -rf /tmp/x/.*', 'rm -rf /tmp/*/x', 'rm -rf /tmp/x/[ab]', 'rm -rf ~/x/*'])
    assert.equal(act(c), 'ask', c);
});

test('a plain push and rm of a file are not risky', () => {
  assert.equal(evaluateCommand({ command: 'git push origin x', state: fresh(), host: calm, rules }).action, 'allow');
  assert.equal(evaluateCommand({ command: 'rm notes.txt', state: fresh(), host: calm, rules }).action, 'allow');
});

test('heavy command on a strained host: deny once, then allow', () => {
  const state = fresh();
  const strained = { load1: 45, freeGb: 100 };
  assert.equal(evaluateCommand({ command: 'npm run build', state, host: strained, rules }).action, 'deny');
  assert.equal(evaluateCommand({ command: 'npm run build', state, host: strained, rules }).action, 'allow');
});

test('heavy command through the heavy wrapper is not denied, and the deny points to it', () => {
  const strained = { load1: 45, freeGb: 100 };
  assert.equal(evaluateCommand({ command: '~/skills/host-hygiene/scripts/heavy.sh npm run build', state: fresh(), host: strained, rules }).action, 'allow');
  assert.equal(evaluateCommand({ command: 'pwsh heavy.ps1 -- npm test', state: fresh(), host: { cpuPercent: 97, freeGb: 100 }, rules }).action, 'allow');
  assert.equal(evaluateCommand({ command: 'scripts/lease.sh ios-sim -- maestro test flow.yaml', state: fresh(), host: strained, rules }).action, 'allow');
  assert.match(evaluateCommand({ command: 'npm run build', state: fresh(), host: strained, rules }).reason, /scripts\/heavy\.sh.*scripts\/lease\.sh/);
});

test('heavy command on a healthy host passes; low disk counts as strained', () => {
  assert.equal(evaluateCommand({ command: 'eas build', state: fresh(), host: calm, rules }).action, 'allow');
  assert.equal(evaluateCommand({ command: 'eas build', state: fresh(), host: { load1: 1, freeGb: 5 }, rules }).action, 'deny');
});

test('usage levels and spawn throttling', () => {
  assert.equal(usageLevel(10, rules), 'ok');
  assert.equal(usageLevel(75, rules), 'warn');
  assert.equal(usageLevel(95, rules), 'throttle');
  assert.equal(usageLevel(undefined, rules), 'unknown');
  assert.equal(evaluateSpawn({ usagePercent: 75, rules }).action, 'allow');
  const d = evaluateSpawn({ usagePercent: 95, resetsAt: '2030-01-01T00:00:00Z', rules });
  assert.equal(d.action, 'deny');
  assert.match(d.reason, /95%/);
  assert.match(d.reason, /resets/);
  assert.doesNotMatch(evaluateSpawn({ usagePercent: 95, rules }).reason, /resets/);
});

test('Windows hosts are judged on cpu percent instead of load average', () => {
  assert.equal(evaluateCommand({ command: 'npm run build', state: fresh(), host: { cpuPercent: 97, freeGb: 100 }, rules }).action, 'deny')
  assert.equal(evaluateCommand({ command: 'npm run build', state: fresh(), host: { cpuPercent: 40, freeGb: 100 }, rules }).action, 'allow')
  const d = evaluateCommand({ command: 'npm run build', state: fresh(), host: { cpuPercent: 97, freeGb: 100 }, rules })
  assert.match(d.reason, /cpu 97%/)
})

test('blast radius: previews are read-only commands', async () => {
  const { previewCommand, withPreview } = await import('./engine.mjs');
  assert.deepEqual(previewCommand('reset', 'git reset --hard HEAD~1'), ['git', 'status', '--short']);
  assert.deepEqual(previewCommand('force', 'git push --force'), ['git', 'log', '--oneline', '-n', '10', 'HEAD..@{u}']);
  assert.deepEqual(previewCommand('rm', 'rm -rf dist build/out', rules), ['du', '-sh', '--', 'dist', 'build/out']);
  // G05: the preview follows cd, ~ and variables, and leaves the rest of the chain out.
  assert.deepEqual(previewCommand('rm', 'cd sub && rm -rf build', rules), ['du', '-sh', '--', 'sub/build']);
  assert.deepEqual(previewCommand('rm', 'rm -rf a; curl x', rules), ['du', '-sh', '--', 'a']);
  assert.deepEqual(previewCommand('rm', 'D=/srv/x; rm -rf $D ~/y', rules, { HOME: '/Users/me' }), ['du', '-sh', '--', '/srv/x', '/Users/me/y']);
  assert.equal(previewCommand('terraform', 'terraform apply'), null);
});

test('blast radius: rm paths with shell syntax get no preview', async () => {
  const { previewCommand } = await import('./engine.mjs');
  for (const c of ['rm -rf $HOME', 'rm -rf "a b"', 'rm -rf `pwd`', 'rm -rf $(x)', 'rm -rf ~/x', "ssh h 'rm -rf /srv/x'"])
    assert.equal(previewCommand('rm', c, rules), null, c);
});

test('text that only mentions a risky phrase does not trigger it', () => {
  const ask = (command) => evaluateCommand({ command, state: fresh(), host: calm, rules }).action;
  const mentions = [
    'echo "git reset --hard"',
    "grep -rn 'rm -rf' docs/",
    'cat > t.mjs <<\'EOF\'\ngit reset --hard\nrm -rf x\nEOF',
    'gh pr create --body "never run git push --force"',
  ];
  for (const c of mentions) assert.notEqual(ask(c), 'ask', c);
});

test('real risky commands still ask, also after a heredoc and inside -c', () => {
  const ask = (command) => evaluateCommand({ command, state: fresh(), host: calm, rules }).action;
  assert.equal(ask('cat <<EOF\nhi\nEOF\nrm -rf build'), 'ask');
  assert.equal(ask('echo ok && git reset --hard'), 'ask');
  assert.equal(ask('bash -c "rm -rf build"'), 'ask');
  assert.equal(ask("sh -c 'git push --force'"), 'ask');
});

test('blast radius: preview is appended and truncated', async () => {
  const { withPreview } = await import('./engine.mjs');
  assert.equal(withPreview('why', ''), 'why');
  const out = withPreview('why', Array.from({ length: 15 }, (_, i) => `l${i}`).join('\n'));
  assert.match(out, /Would affect:\nl0/);
  assert.match(out, /… 3 more$/);
});

test('commit messages and PR titles must be Conventional Commits', () => {
  const run = (command) => evaluateCommand({ command, loadedSkills: new Set(['ship', 'github-workflow']), state: fresh(), host: calm, rules });
  for (const command of ['git commit -m "fix stuff"', "git commit -am 'Update readme'", 'gh pr create --title "Add thing" --body x', 'git commit -m "feat: Add"']) {
    const r = run(command);
    assert.equal(r.action, 'deny', command);
    assert.equal(r.rule, 'title', command);
    assert.equal(run(command).action, 'deny', 'every time, not once');
  }
  for (const command of ['git commit -m "fix(core): handle empty title"', 'gh pr create --title "feat!: drop node 20" --body x', 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nbody\nEOF\n)"', 'git commit --amend --no-edit', 'gh pr create --fill', 'git commit -m "$msg"', 'git commit -F msg.txt', 'echo git commit -m Bad', 'git merge x && git commit -m "Merge branch \'x\'"']) {
    assert.equal(run(command).action, 'allow', command);
  }
});

test('every title in a command is read: heredocs, -F -, chains, payloads, gh pr edit, the first -m only', () => {
  const title = (command) => badTitle(command, rules);
  assert.equal(title('git commit -m "$(cat <<\'EOF\'\nwhatever\nEOF\n)"'), 'whatever');
  assert.equal(title("git commit -F - <<'EOF'\nBad\nEOF"), 'Bad');
  assert.equal(title('git commit --file=- <<EOF\nBad\nEOF'), 'Bad');
  assert.equal(title("git commit -F- <<'EOF'\nfix: ok\nEOF"), null);
  assert.equal(title('git commit -m "feat: x" && gh pr create --title "Bad PR"'), 'Bad PR');
  assert.equal(title('gh pr edit 3 --title=Bad'), 'Bad');
  assert.equal(title("bash -c 'git commit -m Bad'"), 'Bad');
  assert.equal(title('git commit -m "$msg" -m "Co-Authored-By: x"'), null);
  assert.equal(title('git commit -m "Bad" -m "feat: x"'), 'Bad');
  assert.equal(title('git commit -mBad'), 'Bad');
  assert.equal(title('git commit -m "  feat: ok"'), '  feat: ok');
  assert.equal(title('git commit -m "fix: 123"'), 'fix: 123', 'the org check wants a lowercase letter first');
  assert.equal(title('git commit -m "feat(a,b): x"'), 'feat(a,b): x', 'and no comma in the scope');
});

const decide = (command, facts = {}) => evaluateCommand({ command, state: fresh(), host: calm, rules, ...facts });
const macEnv = { TMPDIR: '/var/folders/ab/xyz/T/' };

test('safe targets: temp dirs pass the risky guard', () => {
  for (const c of ['rm -rf /tmp/build', 'rm -rf /private/tmp/a /tmp/b', 'rm -rf /var/folders/ab/xyz/T/x', 'rm -rf $TMPDIR/x', 'rm -rf "${TMPDIR}"x 2>/dev/null', 'rm -rf ${TMPDIR}/x 2>&1', 'cd /tmp && rm -rf /tmp/x'])
    assert.equal(decide(c, { env: macEnv }).action, c.includes('"') ? 'ask' : 'allow', c);
});

test('unsafe targets: mixed, root, home, globs, variables and .. still ask', () => {
  for (const c of ['rm -rf /tmp/x build', 'rm -rf /tmp/x /', 'rm -rf /', 'rm -rf ~', 'rm -rf ~/tmp/x', 'rm -rf /tmp', 'rm -rf /tmp/', 'rm -rf /tmp/*', 'rm -rf /tmp/../etc', 'rm -rf $TMPDIR', 'rm -rf $HOME/x', 'rm -rf /tmp/$(x)', 'rm -rf /TMP/x', 'rm -rf /tmp/x && rm -rf build', 'find /tmp -exec rm -rf {} \;', 'xargs rm -rf'])
    assert.equal(decide(c, { env: macEnv }).action, 'ask', c);
  assert.equal(decide('rm -rf $TMPDIR/x').action, 'ask', 'unset TMPDIR resolves to /x');
});

test('a safe rm does not hide another risky command', () => {
  assert.equal(decide('rm -rf /tmp/x && git reset --hard').rule, 'reset');
});

test('safe targets: Windows temp paths', () => {
  const env = { TEMP: 'C:\\Users\\GIO~1\\AppData\\Local\\Temp', TMP: 'C:\\Users\\GIO~1\\AppData\\Local\\Temp' };
  for (const c of ['Remove-Item -Recurse -Force $env:TEMP\\build', 'Remove-Item -Recurse -Force -Path $env:temp\\a', 'Remove-Item C:\\Users\\gio\\AppData\\Local\\Temp\\x -Recurse', 'rm -rf %TEMP%\\x', 'rm -rf C:/Users/gio/AppData/Local/Temp/x'])
    assert.equal(decide(c, { env }).action, 'allow', c);
  for (const c of ['Remove-Item -Recurse $env:TEMP', 'Remove-Item -Recurse $env:TEMP\\a,C:\\Windows', 'Remove-Item -Recurse C:\\Users\\gio\\Documents', 'Remove-Item -Recurse $env:USERPROFILE\\x', 'Remove-Item -Recurse $env:TEMP\\..\\x'])
    assert.equal(decide(c, { env }).action, 'ask', c);
  assert.equal(decide('Remove-Item -Recurse $env:TEMP\\x').action, 'ask', 'unset TEMP');
});

// Fake git: one linked worktree per path with `ahead` unpushed commits and `status` porcelain output.
const fakeGit = (trees) => async (argv) => {
  const t = trees[argv[2]];
  if (!t) return null;
  if (argv[3] === 'rev-parse') return t.main ? '/r/.git\n/r/.git\n\n' : `/r/.git/worktrees/x\n/r/.git\n${t.prefix ?? ''}\n`;
  if (argv[3] === 'status') return t.status ?? '';
  if (argv[3] === 'rev-list') return t.fail ? null : `${t.ahead ?? 0}\n`;
};

test('worktrees: merged or pushed and clean is allowed, rm or git worktree remove', async () => {
  const run = fakeGit({ '/r/.claude/worktrees/x': {}, 'C:\\r\\.claude\\worktrees\\x': {} });
  for (const c of ['rm -rf /r/.claude/worktrees/x', 'git worktree remove --force /r/.claude/worktrees/x', 'rm -rf /r/.claude/worktrees/x /tmp/y', 'Remove-Item -Recurse -Force C:\\r\\.claude\\worktrees\\x']) {
    const worktrees = await worktreeFacts(c, {}, rules, run);
    assert.equal(decide(c, { worktrees }).action, 'allow', c);
  }
});

test('worktrees: unpushed, dirty, failing git, main checkout or subdir still ask, and say why', async () => {
  const run = fakeGit({ a: { ahead: 3 }, b: { status: ' M f\n' }, c: { fail: true }, main: { main: true }, sub: { prefix: 'src/' } });
  const ask = async (c) => decide(c, { worktrees: await worktreeFacts(c, {}, rules, run) });
  assert.match((await ask('rm -rf a')).reason, /Worktree a: 3 unpushed commits/);
  assert.match((await ask('git worktree remove -f b')).reason, /Worktree b: dirty tree/);
  assert.match((await ask('rm -rf c')).reason, /Worktree c: git check failed/);
  for (const c of ['rm -rf main', 'rm -rf sub', 'rm -rf nothere']) assert.equal((await ask(c)).action, 'ask', c);
  const throwing = await worktreeFacts('rm -rf a', {}, rules, async () => { throw new Error('boom') });
  assert.equal(decide('rm -rf a', { worktrees: throwing }).action, 'ask');
});

// Fake git + gh for squash-merged worktrees: `ahead` commits on no remote, `pr` the merged PR head ('' none, null gh fails),
// `inPr` whether HEAD is contained in it. gh runs with the worktree root as cwd.
const fakeSquash = (trees) => async (argv, cwd) => {
  const t = trees[argv[0] === 'gh' ? cwd : argv[2]];
  if (!t) return null;
  if (argv[0] === 'gh') return t.pr == null ? null : `${t.pr}\n`;
  if (argv[3] === 'rev-parse') return `/r/.git/worktrees/x\n/r/.git\n\n${argv[2]}\n`;
  if (argv[3] === 'status') return t.status ?? '';
  if (argv[3] === 'rev-list') return '2\n';
  if (argv[3] === 'branch') return 'fix/x\n';
  if (argv[3] === 'merge-base') return t.inPr === false ? null : '';
};

test('worktrees: squash-merged (merged PR, remote branch deleted) and clean is allowed', async () => {
  const run = fakeSquash({ a: { pr: 'abc' } });
  for (const c of ['rm -rf a', 'git worktree remove --force a'])
    assert.equal(decide(c, { worktrees: await worktreeFacts(c, {}, rules, run) }).action, 'allow', c);
});

test('worktrees: squash-merged but dirty, gh failing, no merged PR or commits after it still ask, and say why', async () => {
  const run = fakeSquash({ d: { pr: 'abc', status: ' M f\n' }, g: { pr: null }, n: { pr: '' }, l: { pr: 'abc', inPr: false } });
  const ask = async (c) => decide(c, { worktrees: await worktreeFacts(c, {}, rules, run) });
  assert.match((await ask('rm -rf d')).reason, /Worktree d: 2 unpushed commits, dirty tree/);
  assert.match((await ask('rm -rf g')).reason, /Worktree g: 2 unpushed commits \(gh check failed\)/);
  assert.match((await ask('rm -rf n')).reason, /Worktree n: 2 unpushed commits \(no merged PR\)/);
  assert.match((await ask('rm -rf l')).reason, /Worktree l: 2 unpushed commits \(HEAD not in the merged PR\)/);
});

test('a for loop over plain words is expanded per word: clean worktrees and temp paths pass', async () => {
  const run = fakeGit({ '.claude/worktrees/a': {}, '.claude/worktrees/b': {}, '/r/.claude/worktrees/a': {}, '../../../.claude/worktrees/a': {} });
  for (const c of [
    'for w in a b; do git worktree remove --force .claude/worktrees/$w; done',
    'for w in a b; do\n  git worktree remove --force ".claude/worktrees/${w}"\ndone && git worktree prune',
    'for w in a b; do git worktree remove --force .claude/worktrees/$w && git branch -d fix/$w; done',
    'cd /r && for w in a; do git worktree remove -f .claude/worktrees/$w; done',
    'cd ../../.. && git worktree remove --force .claude/worktrees/a',
    'for d in /tmp/x /tmp/y; do rm -rf $d; done',
    'for d in x y; do rm -rf "$TMPDIR/$d"; done',
  ])
    assert.equal(decide(c, { env: { TMPDIR: '/var/folders/ab/T/' }, worktrees: await worktreeFacts(c, {}, rules, run) }).action, 'allow', c);
});

test('loops and cd that cannot be resolved statically, or a dirty worktree in the list, still ask', async () => {
  const run = fakeGit({ '.claude/worktrees/a': {}, '.claude/worktrees/b': { status: ' M f\n' }, a: {} });
  const ask = async (c) => decide(c, { worktrees: await worktreeFacts(c, {}, rules, run) });
  assert.match((await ask('for w in a b; do git worktree remove --force .claude/worktrees/$w; done')).reason, /Worktree \.claude\/worktrees\/b: dirty tree/);
  for (const c of [
    'for w in .claude/worktrees/*; do git worktree remove --force $w; done',
    'for w in $(ls .claude/worktrees); do git worktree remove --force .claude/worktrees/$w; done',
    'for w in "a" b; do git worktree remove --force .claude/worktrees/$w; done',
    'for w in a; do git worktree remove --force .claude/worktrees/$u; done',
    'for w in a; do w=/; rm -rf $w; done',
    'for w in a; do for v in b; do rm -rf .claude/worktrees/$w; done; done',
    'for w in a; do read w; rm -rf .claude/worktrees/$w; done',
    'echo "for w in a; do x"; rm -rf /tmp/$w; echo "; done"',
    'git worktree remove --force .claude/worktrees/$w',
    'cd /elsewhere && git worktree remove --force a',
    'cd "$HOME" && git worktree remove --force a',
    'cd ~ && rm -rf a',
    '(cd /r; rm -rf x) && git worktree remove -f a',
    'false || cd /r; git worktree remove -f a',
  ])
    assert.equal((await ask(c)).action, 'ask', c);
});

test('git worktree remove without --force is not risky', () => {
  assert.equal(decide('git worktree remove /r/x').action, 'allow');
});

test('in a uv repo pip, pipx and poetry are denied every time; uv and quoted mentions pass', () => {
  const state = fresh();
  const run = (command, s = state) => evaluateCommand({ command, state: s, host: calm, python: 'uv', rules });
  for (const c of ['pip install x', 'pip3 install -r r.txt', 'pipx run black', 'python3 -m pip install x', 'cd a && pip install x', 'PIP install x']) {
    const r = run(c);
    assert.equal(r.action, 'deny', c);
    assert.equal(r.rule, 'pip', c);
  }
  assert.equal(run('pip install x').action, 'deny');
  for (const c of ['poetry add x', 'poetry install', 'cd a && poetry lock']) {
    assert.equal(run(c).rule, 'poetry', c);
    assert.equal(run(c).action, 'deny', c);
  }
  for (const c of ['uv pip install x', 'uv add x', 'pip-compile r.in', 'pipenv sync', 'echo "pip install x"', 'grep pipeline f', 'cat poetry.lock']) {
    assert.equal(run(c, fresh()).action, 'allow', c);
  }
});

test('outside a uv repo pip and poetry are allowed, with a note once per session', () => {
  for (const [python, c] of [['poetry', 'pip install x'], ['pip', 'pip install -r requirements.txt'], ['poetry', 'poetry add x'], [null, 'pipx run black']]) {
    const state = fresh();
    const first = evaluateCommand({ command: c, state, host: calm, python, rules });
    assert.equal(first.action, 'allow', c);
    assert.match(first.context, python ? new RegExp(`uses ${python}`) : /no uv project/, c);
    assert.match(first.context, /uv is preferred/);
    assert.deepEqual(evaluateCommand({ command: c, state, host: calm, python, rules }), { action: 'allow' }, c);
  }
});

test('the note does not hide a risky command', () => {
  assert.equal(evaluateCommand({ command: 'pip install x && rm -rf build', state: fresh(), host: calm, python: 'pip', rules }).action, 'ask');
});

test('GitLab and Azure DevOps titles must be Conventional Commits', () => {
  const run = (command) => evaluateCommand({ command, loadedSkills: new Set(['ship']), state: fresh(), host: calm, rules });
  for (const c of ['glab mr create --title "Add thing" -d x', 'glab mr create -t "fix stuff"', 'glab mr update 3 --title=\'Update\'', 'az repos pr create --title "Add thing" -t main', 'az repos pr update --id 4 --title "feat: Add"']) {
    const r = run(c);
    assert.equal(r.action, 'deny', c);
    assert.equal(r.rule, 'title', c);
  }
  for (const c of ['glab mr create -t "feat(api): add thing" -d x', 'glab mr create --fill', 'az repos pr create --title "fix: handle x" -t "Main Branch"', 'az repos pr update --id 4 --auto-complete true']) {
    assert.equal(run(c).action, 'allow', c);
  }
});

test('glab and az PR commands need the PR skills; an az policy bypass asks', () => {
  for (const c of ['glab mr create --fill', 'glab mr merge 3 --auto-merge', 'az repos pr create --title "feat: x"', 'az repos pr update --id 4 --auto-complete true']) {
    const r = evaluateCommand({ command: c, state: fresh(), host: calm, rules });
    assert.equal(r.rule, 'pr', c);
    assert.match(r.reason, /repo-standard/, c);
  }
  const ask = (c) => evaluateCommand({ command: c, loadedSkills: new Set(['land']), state: fresh(), host: calm, rules }).action;
  assert.equal(ask('az repos pr update --id 4 --bypass-policy true --bypass-policy-reason x'), 'ask');
  assert.equal(ask('az repos pr update --id 4 --bypass-policy false'), 'allow');
});

test('secret reads ask every time, naming secrets-handling; look-alikes and injection wrappers pass', () => {
  const decide = (command) => evaluateCommand({ command, state: fresh(), host: calm, rules });
  const asks = {
    secrets: [
      'bws secret get 0000', 'bws secret list', 'bws run -- make deploy', 'bw get password github', 'bw list items --search x',
      'bw unlock', 'bw login', 'bw export --format json', 'bw serve --port 8087',
      'security find-generic-password -s svc -w', 'security find-generic-password -wa acct', 'security find-internet-password -s host -g',
      'chezmoi secret keyring get --service=svc --user=me',
      'op read op://vault/item/field', 'op item get github --fields password --reveal',
      'pass show email/me', 'gcloud secrets versions access latest --secret=api', 'az keyvault secret show --vault-name v --name n',
      'printenv GITHUB_TOKEN', 'echo ok && printenv API_KEY',
      'cat .env', 'less .env.local', 'cat ./app/.env', 'head -n 5 config/.env.production', 'X=$(bws secret get 0000) ./run.sh',
      'env | sort | grep PASSWORD', 'env', 'printenv | sort', 'gh auth token', 'echo "$GITHUB_TOKEN"', 'grep X .env', 'source .env', '. ./.env', 'cat ~/.aws/credentials',
    ],
    'secrets-env': ['printenv | grep TOKEN', 'env | grep -i "secret"', "env | rg -i 'api_key'", 'env | grep TOKEN | sort'],
  };
  for (const [rule, commands] of Object.entries(asks))
    for (const command of commands) {
      const d = decide(command);
      assert.equal(d.action, 'ask', command);
      assert.equal(d.rule, rule, command);
      assert.match(d.reason, /secrets-handling/, command);
      assert.equal(decide(command).action, 'ask', command);
    }
  for (const command of [
    'BWS_ACCESS_TOKEN="$(security find-generic-password -s bws -w)" ./scripts/create_secrets.sh n8n',
    'BWS_ACCESS_TOKEN="$(chezmoi secret keyring get --service=bws --user=me)" make sync',
    'bws --version', 'bw status', 'bw sync', 'bws project list',
    'security find-generic-password -s svc', 'security find-generic-password -a me -s gmail', 'security list-keychains',
    'op item get github --fields username', 'op whoami', 'pass ls', 'pass insert x',
    'gcloud secrets list', 'gcloud secrets versions list api', 'az keyvault secret list --vault-name v',
    'printenv PATH', 'env | grep PATH', 'echo $KEY_PATH', 'echo $HOME', 'env FOO=1 node app.js | grep ok', 'docker compose --env-file .env config | grep image',
    'cat .env.example', 'cat .env.sample', 'cat .envrc.example', 'cat foo.env', 'cat environment.md', 'echo "cat .env"',
    "grep -rn 'bws secret get' docs/", 'git commit -m "docs: never run printenv | grep TOKEN"',
  ])
    assert.notEqual(decide(command).action, 'ask', command);
});

test('the secrets prefixes leave plain secret reads to the Codex and opencode prompts', () => {
  assert.equal(nativeAsk('bws secret get 0000', 'secrets', rules), true);
  assert.equal(nativeAsk('cat .env', 'secrets', rules), true);
  assert.equal(nativeAsk('op item get github --reveal', 'secrets', rules), false);
  assert.equal(nativeAsk('env | grep TOKEN', 'secrets-env', rules), false);
  assert.equal(opencodeAsks(rules)['pass show *'], 'ask');
});

test('remind rules hint once per session and never deny', () => {
  const state = fresh();
  const first = evaluateCommand({ command: 'gh pr view 12 --comments', state, host: calm, rules });
  assert.deepEqual([first.action, first.rule, first.remind], ['allow', 'pr-fix', true]);
  assert.match(first.context, /`pr-fix` or `land`/);
  assert.equal(evaluateCommand({ command: 'gh run view 9 --log-failed', state, host: calm, rules }).context, undefined);
  assert.equal(evaluateCommand({ command: 'uv run pytest -q', loadedSkills: new Set(['python:python-testing']), state: fresh(), host: calm, rules }).remind, undefined);
  assert.equal(evaluateCommand({ command: 'uv run pytest -q', state: fresh(), host: calm, rules }).rule, 'pytest');
  assert.equal(evaluateCommand({ command: 'go test -race ./...', state: fresh(), host: calm, rules }).rule, 'go-test');
  assert.equal(evaluateCommand({ command: 'go test ./...', loadedSkills: new Set(['go:go-testing']), state: fresh(), host: calm, rules }).remind, undefined);
  for (const c of ['go vet ./...', 'golangci-lint run', 'go build ./cmd/x']) {
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, rules }).rule, 'go-lint', c);
  }
  assert.equal(evaluateCommand({ command: 'go build ./...', loadedSkills: new Set(['go:go-development']), state: fresh(), host: calm, rules }).remind, undefined);
  assert.equal(evaluateCommand({ command: 'echo gotest', state: fresh(), host: calm, rules }).rule, undefined);
});

test('a shell-only file read hints at the read tool once, only where the harness has one', () => {
  const state = fresh();
  for (const c of ['cat src/a.py', 'head -n 20 README.md', 'sed -n 1,40p x.ts', 'tail -50 log.txt']) {
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, readTool: true, rules }).rule, 'read', c);
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, readTool: false, rules }).rule, undefined, c);
  }
  for (const c of ['cat a | grep x', 'cd x && cat a', 'cat <<EOF', 'cat $(ls)', 'head -c 10 /dev/urandom > f'])
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, readTool: true, rules }).rule, undefined, c);
  assert.equal(evaluateCommand({ command: 'cat a', state, host: calm, readTool: true, rules }).rule, 'read');
  assert.equal(evaluateCommand({ command: 'cat b', state, host: calm, readTool: true, rules }).rule, undefined);
});

test('an edit under docs/ or to README/AGENTS hints at docs-sync once', () => {
  const state = fresh();
  assert.equal(evaluateEdit({ path: '/r/docs/guard.md', state, rules }).rule, 'docs');
  assert.equal(evaluateEdit({ path: '/r/README.md', state, rules }).rule, undefined); // once
  assert.equal(evaluateEdit({ path: 'C:\\r\\AGENTS.md', state: fresh(), rules }).rule, 'docs');
  assert.equal(evaluateEdit({ path: '/r/src/docs.ts', state: fresh(), rules }).rule, undefined);
  assert.equal(evaluateEdit({ path: '/r/docs/x.md', loadedSkills: new Set(['dev-tools:docs-sync']), state: fresh(), rules }).rule, undefined);
});

test('a spawn that bypasses the typed agents gets one routing hint per case and session', () => {
  const rule = (type, model, state = fresh()) => evaluateRouting({ type, model, state, rules }).rule;
  assert.equal(rule('Plan'), 'routing-plan');
  assert.equal(rule('general-purpose', 'opus'), 'routing-model');
  assert.equal(rule(undefined, 'claude-opus-5-5'), 'routing-model');
  assert.equal(rule('claude', 'fable'), 'routing-model');
  assert.equal(rule('general-purpose', 'gpt-6.1-sol'), 'routing-model');
  assert.equal(rule('dev-tools:driver', 'opus'), 'routing-override');
  assert.equal(rule('scout', 'haiku'), 'routing-override');
  // Routed as the skill says: a typed agent without a model, a routine unit on Sonnet, the verifier's per-change model.
  assert.equal(rule('dev-tools:driver'), undefined);
  assert.equal(rule('general-purpose', 'sonnet'), undefined);
  assert.equal(rule('general-purpose'), undefined);
  assert.equal(rule('factory:verifier', 'sonnet'), undefined);
  assert.equal(rule('api:api-reviewer', 'opus'), undefined);
  assert.equal(rule('Explore', 'opus'), undefined);
  const state = fresh();
  assert.equal(rule('Plan', undefined, state), 'routing-plan');
  assert.equal(rule('Plan', undefined, state), undefined); // once
  assert.equal(rule('general-purpose', 'opus', state), 'routing-model'); // another case still hints
  assert.match(evaluateRouting({ type: 'Plan', state: fresh(), rules }).context, /dev-tools:driver.*plan-only brief/);
  assert.match(evaluateRouting({ type: 'dev-tools:driver', model: 'opus', state: fresh(), rules }).context, /without a `model`/);
});

test('a malformed spawn (non-string type or model) never throws and gets no decision', () => {
  for (const [type, model] of [[null, null], [42, {}], [{}, 7], [[], ['opus']], [true, false]]) {
    assert.equal(evaluateRouting({ type, model, state: fresh(), rules }).action, 'allow', JSON.stringify([type, model]));
  }
});

const outcome = (command, facts = {}) => {
  const d = evaluateCommand({ command, state: fresh(), host: calm, readTool: true, rules, ...facts });
  return d.remind ? `remind:${d.rule}` : d.rule ? `${d.action}:${d.rule}` : d.action;
};

test("git's global options before the subcommand hide no rule", () => {
  for (const [c, want] of [
    ['git -C x reset --hard', 'ask:reset'], ['git -C x push --force', 'ask:force'], ['git -C x worktree remove --force y', 'ask:worktree-rm'],
    ['git -c core.editor=true reset --hard', 'ask:reset'], ['git --git-dir=.git --work-tree=. reset --hard', 'ask:reset'],
    ['git --git-dir .git --work-tree . reset --hard', 'ask:reset'], ['git --no-pager push -f origin x', 'ask:force'],
    ['git -C a -c k=v --no-pager reset --hard', 'ask:reset'], ['git -c "user.name=a b" -C x clean -fd', 'ask:clean'],
    ['git push https://h/r.git --force main', 'ask:force'], // a `.git` URL is not a git command whose options to drop
    ['git -C x commit -m "fix: ok"', 'deny:commit'], ['git -C x worktree add ../y', 'deny:worktree'], ['git -C x tag v1.2.0', 'deny:release'],
  ])
    assert.equal(outcome(c), want, c);
  const run = (c) => evaluateCommand({ command: c, loadedSkills: new Set(['ship']), state: fresh(), host: calm, rules });
  assert.equal(run('git -C x commit -m "bad title"').rule, 'title');
  assert.equal(run("git -c core.editor=true commit -m 'Update readme'").rule, 'title');
  assert.equal(run('git -C x commit -m "fix: ok"').action, 'allow');
  for (const c of ['git --version', 'git -C x status', 'git -C x push origin feat/x', 'git --no-pager log -n 3'])
    assert.equal(outcome(c), 'allow', c);
});

test('a relative worktree target is resolved against git -C', async () => {
  const run = fakeGit({ '/r/.claude/worktrees/a': {}, '/r/.claude/worktrees/b': { status: ' M f\n' } });
  const decideWith = async (c) => decide(c, { worktrees: await worktreeFacts(c, {}, rules, run) });
  assert.deepEqual(removalTargets('git -C /r worktree remove --force .claude/worktrees/a', rules), ['/r/.claude/worktrees/a']);
  assert.deepEqual(removalTargets('cd /r && git -C sub -C x worktree remove -f y', rules), ['/r/sub/x/y']);
  assert.equal((await decideWith('git -C /r worktree remove --force .claude/worktrees/a')).action, 'allow');
  assert.match((await decideWith('git -C /r worktree remove --force .claude/worktrees/b')).reason, /dirty tree/);
  assert.equal((await decideWith('git -C "$R" worktree remove --force a')).action, 'ask');
});

test('every spelling of a recursive delete asks', () => {
  for (const c of ['\\rm -rf build', 'command rm -rf build', '/bin/rm -rf build', 'sudo rm -rf build', 'echo build | xargs rm -rf',
    'Remove-Item -Recurse -Force build', 'Remove-Item -r -fo build', 'Remove-Item build -Recurse:$true', 'Get-ChildItem x | Remove-Item -Rec',
    'ri -Recurse build', 'rmdir /s /q build', 'rd /S build', 'del /s /q build'])
    assert.equal(outcome(c), 'ask:rm', c);
  for (const c of ['find . -name "*.log" -delete', 'find . -type f -exec rm {} \\;', 'find build -execdir /bin/rm -f {} +'])
    assert.equal(outcome(c), 'ask:find', c);
  assert.equal(outcome('find build -exec rm -r {} +'), 'ask:rm');
  for (const c of ['Remove-Item build', 'Remove-Item -ReadCount 1 x', 'rmdir empty', 'grep rd -r src', 'find . -name x', 'find . -exec grep rm {} +', 'del x.txt'])
    assert.equal(outcome(c), 'allow', c);
});

test('a find delete under a temp dir passes; a delete with no target never rides on a safe one', () => {
  for (const c of ['find /tmp/x -name "*.log" -delete', 'find /tmp/x -exec rm -rf {} +'])
    assert.equal(outcome(c), 'allow', c);
  for (const c of ['find -delete', 'find -L /tmp/x -delete', 'echo / | xargs rm -rf && rm -rf /tmp/x', 'find . -delete; rm -rf /tmp/x'])
    assert.equal(outcome(c).startsWith('ask'), true, c);
});

test('git commands that destroy uncommitted or unpushed work ask', () => {
  for (const [c, rule] of [
    ['git clean -fdx', 'clean'], ['git clean -f', 'clean'], ['git clean --force -d', 'clean'], ['git clean -xdf', 'clean'],
    ['git checkout -- .', 'discard'], ['git checkout .', 'discard'], ['git checkout HEAD -- src/', 'discard'], ['git checkout -- "*.ts" :/', 'discard'],
    ['git checkout -f main', 'discard'], ['git switch --discard-changes main', 'discard'], ['git switch -f main', 'discard'],
    ['git restore .', 'discard'], ['git restore --staged --worktree .', 'discard'], ['git restore -W -S :/', 'discard'], ['git restore --source=HEAD~1 src/', 'discard'],
    ['git stash drop', 'stash'], ['git stash drop stash@{1}', 'stash'], ['git stash clear', 'stash'],
    ['git push --mirror', 'push-delete'], ['git push --prune origin', 'push-delete'], ['git push origin --delete main', 'push-delete'],
    ['git push -d origin master', 'push-delete'], ['git push origin :main', 'push-delete'], ['git push origin :refs/heads/master', 'push-delete'],
    ['git rm -rf src', 'git-rm'], ['git rm --force a.txt', 'git-rm'],
  ])
    assert.equal(outcome(c), `ask:${rule}`, c);
  for (const c of ['git clean -n', 'git clean -fdn', 'git clean --dry-run -f', 'git checkout main', 'git checkout -b feat/x origin/main', 'git checkout -',
    'git checkout -- src/a.ts', 'git restore src/a.ts', 'git restore --staged .', 'git restore -S .', 'git switch main', 'git stash', 'git stash pop', 'git stash list',
    'git push origin --delete fix/main', 'git push origin --delete feat/x', 'git push origin main', 'git push -u origin feat/x',
    'git rm -r --cached x', 'git rm -r dir', 'git rm -rf --cached dir', 'git push origin x && git checkout main'])
    assert.equal(outcome(c), 'allow', c);
});

// Fake git + gh for branch deletes: `ahead` commits on no remote ref, `pr` the merged PR head, `inPr` the tip in it.
const fakeBranches = (branches) => async (argv) => {
  const b = branches[argv[0] === 'gh' ? argv[4] : argv[5]];
  if (argv[0] === 'gh') return b?.pr == null ? null : `${b.pr}\n`;
  if (argv[3] === 'rev-parse') return '/r\n';
  if (!b) return null;
  if (argv[3] === 'rev-list') return `${b.ahead ?? 0}\n`;
  if (argv[3] === 'merge-base') return b.inPr === false ? null : '';
};

test('git branch -D asks unless the branch is pushed or in a merged PR', async () => {
  const run = fakeBranches({ pushed: {}, squashed: { ahead: 2, pr: 'abc' }, local: { ahead: 1, pr: '' }, after: { ahead: 3, pr: 'abc', inPr: false } });
  const decideWith = async (c) => decide(c, { branches: await branchFacts(c, rules, run) });
  for (const c of ['git branch -D pushed', 'git branch -D squashed pushed', 'git -C /r branch --delete --force squashed', 'git branch -df pushed'])
    assert.equal((await decideWith(c)).action, 'allow', c);
  assert.match((await decideWith('git branch -D local')).reason, /Branch local: 1 unpushed commit \(no merged PR\)/);
  assert.match((await decideWith('git branch -D pushed after')).reason, /Branch after: 3 unpushed commits \(tip not in the merged PR\)/);
  for (const c of ['git branch -D gone', 'git branch -D', 'git branch -D $B', 'git branch -d -f local'])
    assert.equal((await decideWith(c)).action, 'ask', c);
  for (const c of ['git branch -d x', 'git branch -m a b', 'git branch --list'])
    assert.equal(outcome(c), 'allow', c);
  assert.deepEqual(branchTargets('cd /r && git -C sub branch -D a b', rules), [{ dir: '/r/sub', name: 'a' }, { dir: '/r/sub', name: 'b' }]);
});

test('ignored regenerable output is deleted without asking; anything else asks', async () => {
  const ignored = new Set(['.|node_modules', '.|.venv', '.|dist', 'evals|results', 'web|.next', '/r/app|build', '.|.env', '.|secrets']);
  const run = async (argv) => (argv.includes('check-ignore') && ignored.has(`${argv[2]}|${argv.at(-1)}`) ? '' : null);
  const decideWith = async (c) => decide(c, { regenerable: await regenFacts(c, {}, rules, run) });
  for (const c of ['rm -rf node_modules', 'rm -rf .venv dist/', 'rm -rf evals/results', 'cd web && rm -rf .next', 'rm -rf /r/app/build /tmp/x', 'Remove-Item -Recurse -Force node_modules', 'find dist -delete'])
    assert.equal((await decideWith(c)).action, 'allow', c);
  for (const c of ['rm -rf build', 'rm -rf node_modules src', 'rm -rf results', 'rm -rf .env', 'rm -rf secrets', 'rm -rf node_modules/*', 'rm -rf ~/node_modules', 'cd "$X" && rm -rf dist'])
    assert.equal((await decideWith(c)).action, 'ask', c);
  assert.equal(regenerableName('a/secret-build/dist'), false);
  assert.equal(regenerableName('pkg/.env.cache'), false);
  assert.equal(regenerableName('x/key.key'), false);
  assert.equal(regenerableName('plugins/p/evals/results/'), true);
});

test('shell file edits remind once toward the edit tool; reads, temp and stream writes do not', () => {
  const env = { TMPDIR: '/var/folders/ab/T/', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp' };
  for (const c of [
    "sed -i 's/a/b/' f.txt", "sed -i '' -e 's/a/b/' f.txt", "sed -E -i.bak 's/a/b/' f", "perl -pi -e 's/a/b/' f.txt", "perl -i -pe 's/a/b/' f",
    'python3 - <<EOF\nopen("a.txt", "w").write("x")\nEOF', "python3 -c \"open('a.txt','w').write('x')\"", "uv run python -c \"from pathlib import Path; Path('a').write_text('x')\"",
    'python3 <<EOF\nwith open(os.path.join(d, "f"), mode="a") as f: f.write("x")\nEOF', "node -e \"require('fs').writeFileSync('a.json', '{}')\"",
    'cat > f.txt <<EOF\nx\nEOF', 'cat <<EOF > f.txt\nx\nEOF', 'echo x | tee f.txt', 'echo x | tee -a /tmp/x f.txt', 'echo x > f.txt', 'printf x >> f.txt',
    'echo x 1> f.txt', 'echo x &> f.txt', 'sudo echo x > /etc/hosts', 'Set-Content -Path f.txt -Value x', "'x' | Out-File notes.md",
  ])
    assert.equal(outcome(c, { env }), 'remind:edit', c);
  for (const c of [
    'echo x > /dev/null', 'echo x > /tmp/f', 'echo x >&2', 'echo x 2>&1', 'echo x > "$TMPDIR/f"', 'S=$(mktemp); echo x > $S', 'echo x | tee /dev/stderr',
    'echo "a > b"', "sed -n 's/x/y/p' f", 'sed -e s/a/b/ f', "perl -Ilib -Mstrict t.pl", 'python3 -c "print(1)"', "python3 -c \"open('a.txt').read()\"",
    "python3 -c \"open('/tmp/x', 'w').write('1')\"", "python3 -c \"import sys; sys.stdout.write('x')\"", 'make test 2> err.log', 'Set-Content $env:TEMP\\x -Value 1',
    'Out-File $null', 'grep -c "a > b" f',
  ])
    assert.notEqual(outcome(c, { env }), 'remind:edit', c);
  const state = fresh();
  assert.equal(evaluateCommand({ command: 'echo x > a', state, host: calm, rules }).rule, 'edit');
  assert.equal(evaluateCommand({ command: 'echo x > b', state, host: calm, rules }).rule, undefined);
});

test('generic false positives stay fixed', () => {
  for (const c of ['git push --force-with-lease origin fix/main-menu', 'git push --force-with-lease origin main-ui', 'git worktree remove x && rm -f y',
    'Remove-Item x; Get-ChildItem -Recurse', 'gh pr merge 1 --squash && echo --admin'])
    assert.doesNotMatch(outcome(c), /^ask/, c);
  assert.equal(outcome('git push --force-with-lease origin refs/heads/main'), 'ask:force');
  assert.equal(evaluateCommand({ command: 'git commit-graph write', state: fresh(), host: calm, rules }).rule, undefined);
});

test('git -C previews the right repo; a dir with shell syntax gets none', async () => {
  const { previewCommand } = await import('./engine.mjs');
  assert.deepEqual(previewCommand('reset', 'git -C ../x reset --hard'), ['git', '-C', '../x', 'status', '--short']);
  assert.equal(previewCommand('force', 'git -C $X push -f'), null);
});

test('readable asks: what the risky part does, the step on its own, where it runs and the rule', () => {
  const ask = (command) => evaluateCommand({ command, state: fresh(), host: calm, loadedSkills: new Set(['ship']), rules });
  const rm = ask('git status && cd sub && rm -rf build dist');
  assert.equal(rm.action, 'ask');
  assert.match(rm.reason, /^Risky command: Deletes 2 paths recursively: sub\/build, sub\/dist\.\nStep: rm -rf build dist\nRule: rm \(recursive delete\)$/);
  assert.match(ask("ssh deploy@pi.local 'cd /srv && rm -rf data'").reason, /Deletes recursively: \/srv\/data on pi\.local\.\nStep: rm -rf data/);
  assert.match(ask('git push -f origin feat').reason, /^Risky command: Force-pushes origin feat\.\nRule: force/);
  assert.match(ask('git branch -D a b').reason, /Deletes branches a, b/);
  assert.match(ask('git reset --hard').reason, /Discards uncommitted changes/);
  assert.match(ask('xargs rm -rf').reason, /paths it cannot read/);
});

test('readable asks: a risky step in a chain of more than 3, or next to 2 others in a payload, is denied with "split it out"', () => {
  const d = (command) => evaluateCommand({ command, state: fresh(), host: calm, loadedSkills: new Set(['ship']), rules });
  for (const c of ['cd app && make && make test && rm -rf src', "bash -c 'cd /srv; make; rm -rf src'", "ssh h 'cd /srv && docker compose pull && rm -rf data'", "eval 'a; b; git reset --hard'"]) {
    const r = d(c);
    assert.deepEqual([r.action, r.split], ['deny', true], c);
    assert.match(r.reason, /Run the risky step as its own simple command/, c);
  }
  for (const c of ['cd app && make && rm -rf src', "ssh h 'cd /srv && rm -rf data'", "bash -c 'rm -rf src'", 'for w in a b c d; do rm -rf $w; done'])
    assert.equal(d(c).action, 'ask', c);
});

test('payloads are judged: shell -c, eval, ssh, heredoc and pipe into a shell ask; mentions do not', () => {
  for (const [c, rule] of [["bash -lc 'rm -rf src'", 'rm'], ["sh -c -- 'git reset --hard'", 'reset'], ['eval "git push -f"', 'force'], ["ssh h 'git branch -D x'", 'branch-delete'], ['echo cm0= | base64 -d | sh', 'opaque']])
    assert.equal(outcome(c), `ask:${rule}`, c);
  for (const c of ["rg -c 'rm -rf x' f", "echo 'git reset --hard'", "ssh h 'rm -rf /tmp/x'"]) assert.equal(outcome(c), 'allow', c);
});

test('remote and container targets never get this machine\'s facts', async () => {
  const calls = [];
  const run = async (argv) => (calls.push(argv), '0\n');
  assert.deepEqual(await branchFacts("ssh h 'git branch -D x'", rules, run), {});
  assert.deepEqual(await regenFacts("ssh h 'rm -rf /srv/node_modules'", {}, rules, run), {});
  assert.deepEqual(await worktreeFacts('docker exec c rm -rf /srv/x', {}, rules, run), {});
  assert.deepEqual(calls, []);
});

test('a heavy command on another host does not trip the local host guard', () => {
  const strained = { load1: 99, freeGb: 100 };
  assert.equal(evaluateCommand({ command: "ssh h 'make test'", state: fresh(), host: strained, rules }).action, 'allow');
  assert.equal(evaluateCommand({ command: "bash -c 'make test'", state: fresh(), host: strained, rules }).rule, 'host');
});

test('cd ~, $HOME, git -C ~ and assigned variables are followed, by position (G04, G01)', async () => {
  const env = { HOME: '/Users/me', TMPDIR: '/var/folders/ab/xyz/T/' };
  const calls = [];
  const run = async (argv) => (calls.push(argv), argv.includes('rev-list') ? '0\n' : null);
  for (const c of ['cd ~/r && git branch -D b', 'git -C ~/r branch -D b', 'R=~/r; git -C $R branch -D b', 'cd $HOME/r && git branch -D b', 'export R=/Users/me/r && cd $R && git branch -D b']) {
    calls.length = 0;
    const branches = await branchFacts(c, rules, run, env);
    assert.deepEqual(Object.keys(branches), ['/Users/me/r|b'], c);
    assert.deepEqual(calls[0].slice(0, 3), ['git', '-C', '/Users/me/r'], c);
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, env, branches, rules }).action, 'allow', c);
  }
  for (const c of ['cd ~other/r && git branch -D b', 'cd $UNSET && git branch -D b', 'R=$(pwd); git -C $R branch -D b', 'R=/srv/r cmd && git -C $R branch -D b'])
    assert.deepEqual(await branchFacts(c, rules, run, env), {}, c);
  assert.deepEqual(removalTargets('T=/tmp/x; T=~; rm -rf $T', rules, env), ['/Users/me']);
  assert.deepEqual(removalTargets('rm -rf $T; T=/tmp/x', rules, env), ['$T']);
  assert.deepEqual(removalTargets('SP=/private/tmp/s; cd $SP && rm -rf a', rules, env), ['/private/tmp/s/a']);
  assert.deepEqual(removalTargets("bash -c 'd=$(mktemp -d); rm -rf $d'", rules, env), ['/tmp/mktemp.placeholder']);
});

test('shell edits judged where they write: cd, variables and sed -i operands (G08)', () => {
  const edit = (c) => shellEdit(c, { TMPDIR: '/var/folders/ab/xyz/T/' });
  assert.equal(edit('cd /private/tmp/s && cat > smoke.py <<EOF\nx\nEOF'), false);
  assert.equal(edit('S=/private/tmp/x; cd $S/scripts && cat > f.py <<EOF\nx\nEOF'), false);
  assert.equal(edit("sed -i '' s/a/b/ /private/tmp/x/scan.py"), false);
  assert.equal(edit("perl -pi -e 's/a/b/' /tmp/x.txt"), false);
  assert.equal(edit('sed -i s/a/b/ src/x.py'), true);
  assert.equal(edit('cd src && cat > x.py <<EOF\nx\nEOF'), true);
  assert.equal(edit("sed -i -e s/a/b/ /tmp/a src/b"), true);
});

test('a worktree with an ignored local secret is not safe to force-remove; ignored build output is (G21)', async () => {
  const { worktreeFact } = await import('./engine.mjs');
  const run = (status) => fakeGit({ w: { status } });
  assert.deepEqual(await worktreeFact('w', run('!! .env\n!! node_modules/\n')), { safe: false, why: 'ignored secrets: .env' });
  assert.deepEqual(await worktreeFact('w', run('!! certs/server.key\n')), { safe: false, why: 'ignored secrets: certs/server.key' });
  assert.deepEqual(await worktreeFact('w', run('!! node_modules/\n!! dist/\n')), { safe: true, why: '' });
});

test('temp paths: only the per-user macOS temp dir, never the tmux, X11 or ssh sockets (G18)', async () => {
  const { isTempPath } = await import('./engine.mjs');
  for (const p of ['/var/folders/ab', '/var/folders/ab/xyz', '/var/folders/ab/xyz/C/x', '/tmp/tmux-501', '/private/tmp/ssh-x/agent.1', '/tmp/.X11-unix/X0', '/tmp/com.apple.launchd.x'])
    assert.equal(isTempPath(p, {}), false, p);
  for (const p of ['/var/folders/ab/xyz/T/tmp.1', '/tmp/x', '/private/tmp/claude-501/s'])
    assert.equal(isTempPath(p, {}), true, p);
  assert.equal(isTempPath('/run/user/1000/tmp/x', { TMPDIR: '/run/user/1000/tmp' }), true);
});

test('the new risky rules reach Codex and opencode as prompt prefixes (D3)', () => {
  const rulesFile = codexRules(rules);
  for (const p of ['["docker","volume","rm"]', '["gh","repo","delete"]', '["kubectl","delete"]', '["helm","uninstall"]', '["tofu","destroy"]', '["git","filter-repo"]', '["mkfs"]'])
    assert.ok(rulesFile.includes(`pattern = ${p}`), p);
  assert.equal(opencodeAsks(rules)['docker volume rm *'], 'ask');
  assert.equal(nativeAsk('docker volume rm firefly_db', 'docker', rules), true);
  assert.equal(nativeAsk('gcloud projects delete p', 'cloud-delete', rules), false);
});

test('cd is followed up to the first branch, subshell or ||, and $PWD is the dir it reached (G23)', () => {
  const env = { HOME: '/Users/me', TMPDIR: '/var/folders/ab/xyz/T/' };
  const S = '/private/tmp/claude-501/p/s1/scratchpad';
  assert.deepEqual(removalTargets(`mkdir -p ${S}/r && cd ${S}/r && rm -rf repo && git clone -q x repo; cd repo && (make test | tail -15)`, rules, env), [`${S}/r/repo`]);
  assert.deepEqual(removalTargets(`cd ${S}/p && D=$PWD/data && rm -rf $D && for i in 1 2; do echo $i & done; wait`, rules, env), [`${S}/p/data`]);
  assert.deepEqual(removalTargets(`cd ${S} && rm -rf "$PWD/a" \${PWD}/b`, rules, env), [`${S}/a`, `${S}/b`]);
  for (const c of [`cd ${S}/p && D=$PWD/data && rm -rf $D`, `cd ${S}; rm -rf a; (make test)`])
    assert.equal(decide(c, { env: { ...env, dirs: new Set([S, `${S}/p`]) } }).action, 'allow', c);
  for (const c of [
    `cd ${S} || true; rm -rf build`,
    `cd ${S} || exit 1; rm -rf build`,
    `cd ${S} && if true; then :; fi; rm -rf build`,
    `(cd ${S}); rm -rf build`,
    `true || cd ${S}; rm -rf build`,
    `pushd ${S} && rm -rf build`,
    `cd ${S} && pushd /r && rm -rf build`,
    'D=$PWD/x; rm -rf $D',
    'cd ~/r && rm -rf $PWD',
    `cd ${S} && cd "$X" && rm -rf $PWD/a`,
  ])
    assert.notEqual(decide(c, { env }).action, 'allow', c);
});

// Fake gh for branch ref deletes: `pr` the merged PR head of a branch, `tip` the ref's current sha.
const fakeRefs = (refs, calls = []) => async (argv, cwd) => {
  calls.push([argv, cwd]);
  if (argv[0] !== 'gh') return null;
  if (argv[1] === 'pr') return refs[argv[argv.indexOf('--head') + 1]]?.pr ?? (refs.fail ? null : '');
  const name = /git\/ref\/heads\/(.+)$/.exec(argv[2])?.[1];
  return refs[name]?.tip == null ? null : `${refs[name].tip}\n`;
};

test('gh api DELETE of a branch ref passes when the ref is the head of a merged PR; anything else asks (G23)', async () => {
  const run = fakeRefs({ 'feat/x': { pr: 'abc\n', tip: 'abc' }, after: { pr: 'abc\n', tip: 'def' }, open: { pr: '', tip: 'abc' }, gone: { pr: 'abc\n' } });
  const decideWith = async (c) => decide(c, { refs: await refFacts(c, rules, run) });
  for (const c of [
    'gh api -X DELETE repos/o/r/git/refs/heads/feat/x',
    'gh api --method DELETE /repos/o/r/git/refs/heads/feat/x',
    'gh api -X=DELETE "repos/o/r/git/refs/heads/feat/x" --silent',
    "gh api repos/o/r/git/refs/heads/feat/x -X DELETE",
    'gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/x',
  ])
    assert.equal((await decideWith(c)).action, 'allow', c);
  assert.match((await decideWith('gh api -X DELETE repos/o/r/git/refs/heads/after')).reason, /Ref after: its tip is not the head of the merged PR/);
  assert.match((await decideWith('gh api -X DELETE repos/o/r/git/refs/heads/open')).reason, /Ref open: no merged PR/);
  for (const c of [
    'gh api -X DELETE repos/o/r/git/refs/heads/gone',
    'gh api -X DELETE repos/o/r/git/refs/heads/main',
    'gh api -X DELETE repos/o/r/git/refs/heads/master',
    'gh api -X DELETE repos/o/r/git/refs/tags/v1.0.0',
    'gh api -X DELETE repos/o/r/git/refs/heads/$B',
    'gh api -X DELETE repos/o/r',
    'gh api -X DELETE repos/o/r/git/refs/heads/feat/x && gh repo delete o/other --yes',
    "ssh h 'gh api -X DELETE repos/o/r/git/refs/heads/feat/x'",
    'gh api -X DELETE repos/o/r --template repos/o/r/git/refs/heads/feat/x',
    'gh api -X DELETE repos/o/r/git/refs/tags/v1.0.0 -t repos/o/r/git/refs/heads/feat/x',
    'gh api -X DELETE repos/o/r/releases/1 --jq repos/o/r/git/refs/heads/feat/x',
    'GH_REPO=o/other gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/x',
    'export GH_REPO=o/other; gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/x',
    'env GH_HOST=ghe.corp gh api -X DELETE repos/o/r/git/refs/heads/feat/x',
    'GH_HOST=ghe.corp gh api -X DELETE repos/o/r/git/refs/heads/feat/x',
    'gh api --hostname ghe.corp -X DELETE repos/o/r/git/refs/heads/feat/x',
    'gh api --hostname=ghe.corp -X DELETE repos/o/r/git/refs/heads/feat/x',
  ])
    assert.equal((await decideWith(c)).action, 'ask', c);
  for (const c of ['gh api -X DELETE -H "Accept: application/vnd.github+json" repos/o/r/git/refs/heads/feat/x', 'gh api --silent -XDELETE -- repos/o/r/git/refs/heads/feat/x'])
    assert.equal((await decideWith(c)).action, 'allow', c);
  assert.equal((await decide('gh api -X DELETE repos/o/r/git/refs/heads/feat/x', { refs: await refFacts('gh api -X DELETE repos/o/r/git/refs/heads/feat/x', rules, fakeRefs({ fail: true })) })).action, 'ask');
  const calls = [];
  await refFacts('cd /r && gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/x', rules, fakeRefs({}, calls));
  assert.deepEqual(calls.map(([argv, cwd]) => [argv.slice(0, 3).join(' '), cwd]), [['gh pr list', '/r'], ['gh api repos/{owner}/{repo}/git/ref/heads/feat/x', '/r']]);
  calls.length = 0;
  await refFacts('gh api -X DELETE repos/o/r/git/refs/heads/feat/x', rules, fakeRefs({}, calls));
  assert.ok(calls[0][0].includes('-R') && calls[0][0].includes('o/r'), 'a literal repo is passed to gh pr list');
});

test('unattendedSet reads GUARD_UNATTENDED set by any command spelling, never from quoted text (G23)', () => {
  for (const c of ['export GUARD_UNATTENDED=1', 'GUARD_UNATTENDED=1 git rebase main', 'GUARD_UNATTENDED=true', 'export GUARD_UNATTENDED="on"; make test', 'cd x && GUARD_UNATTENDED=1 make'])
    assert.equal(unattendedSet(c), true, c);
  for (const c of ['export GUARD_UNATTENDED=0', 'GUARD_UNATTENDED= make', 'export GUARD_UNATTENDED=1; export GUARD_UNATTENDED=off', 'unset GUARD_UNATTENDED'])
    assert.equal(unattendedSet(c), false, c);
  for (const c of ['git commit -m "set GUARD_UNATTENDED=1"', 'echo GUARD_UNATTENDED', "ssh h 'GUARD_UNATTENDED=1 x'", 'cat <<EOF\nGUARD_UNATTENDED=1\nEOF', 'make test'])
    assert.equal(unattendedSet(c), null, c);
});

test('a cd piped or sent to the background is not followed (G23)', () => {
  for (const c of ['cd /tmp/a & rm -rf build', 'cd /tmp/a | cat; rm -rf build', 'x | cd /tmp/a; rm -rf build', 'case x in a) cd /tmp/a;; esac; rm -rf build'])
    assert.equal(decide(c, { env: {} }).action, 'ask', c);
});

test('a branch delete on another host never rides on a safe local one (G23)', async () => {
  const run = async (argv) => (argv.includes('rev-list') ? '0\n' : null);
  const c = "git branch -D a; ssh h 'git branch -D x'";
  const d = decide(c, { branches: await branchFacts(c, rules, run) });
  assert.equal(d.action, 'ask');
  assert.match(d.reason, /x \(on another host\)/);
});

test('a cd that may not have run holds only within its && chain; payloads the outer shell expands use its values (G23 review)', () => {
  const env = { HOME: '/Users/me', TMPDIR: '/var/folders/ab/xyz/T/', dirs: new Set(['/tmp/x', '/Users/me/repo']) };
  for (const c of [
    'cd /tmp/x; rm -rf src',
    'cd /tmp/x\nrm -rf src',
    'cd /tmp/nope && rm -rf src',
    'cd /tmp/x; rmdir /tmp/x/a; rm -rf src',
  ])
    assert.equal(decide(c, { env }).action, 'allow', c);
  for (const c of [
    'cd /tmp/nope; rm -rf src',
    'cd /tmp/nope; rm -rf src; (make test)',
    '[ -d /tmp/x ] && cd /tmp/x; rm -rf src',
    'false && cd /tmp/x; rm -rf build',
    'cd /tmp/nope && cd /tmp/x; rm -rf src',
    'cd /tmp/x &\nrm -rf src',
    'cd /tmp/x & # bg\nrm -rf src',
    'cd /tmp/x |\nrm -rf src',
    'true ||\ncd /tmp/x\nrm -rf src',
    'cd /tmp/x && make & rm -rf src',
    'bash -c "cd /tmp/x && rm -rf $PWD"',
    'sh -c "cd /tmp/x; rm -rf $PWD/src"',
    'bash <<EOF\ncd /tmp/x && rm -rf $PWD\nEOF',
    'echo "cd /tmp/x && rm -rf $PWD" | sh',
    'ssh h "cd /tmp/x && rm -rf $PWD"',
    'D=/Users/me/repo; bash -c "D=/tmp/x; rm -rf $D"',
    'PWD=/tmp/y; cd /Users/me/repo && rm -rf $PWD/src',
    // Round 2: something ran before the cd (it may have removed its directory), or the payload escapes `\$` for itself.
    'cd /Users/me/repo && git pull; cd /tmp/x; rm -rf src',
    'rm -rf /tmp/x; cd /tmp/x; rm -rf src',
    'mv /tmp/x /tmp/y; cd /tmp/x; rm -rf src',
    "rm -rf /tmp/x; bash -c 'cd /tmp/x; rm -rf src'",
    'cd /tmp/x && bash -c "cd /Users/me/repo && rm -rf \\$PWD"',
    'D=/tmp/x; bash -c "D=/Users/me/repo; rm -rf \\$D"',
    'cd /tmp/x && eval "cd /Users/me/repo; rm -rf \\$PWD/src"',
    'D=/tmp/x; echo "rm -rf \\$D/src" | bash',
  ])
    assert.notEqual(decide(c, { env }).action, 'allow', c);
  // The shell runs these in the directory or with the value the guard resolves.
  for (const c of ["bash -c 'cd /tmp/x && rm -rf $PWD/a'", "ssh h 'cd /tmp/x && rm -rf $PWD/a'", 'D=/tmp/x; ssh h "rm -rf $D/a"', '$(cd /tmp/x && rm -rf $PWD/a)'])
    assert.equal(decide(c, { env }).action, 'allow', c);
});

test('git tag -f or -d of a tag no remote has is not a release; anything else still is (G24)', async () => {
  const calls = [];
  const run = async (argv) => {
    calls.push(argv.join(' '));
    if (argv[3] === 'remote') return 'origin\nupstream\n';
    if (argv[3] === 'ls-remote') return argv.at(-1) === 'refs/tags/shared' ? 'abc\trefs/tags/shared\n' : argv.at(-1) === 'refs/tags/flaky' ? null : '';
    return null;
  };
  const decideWith = async (c) => evaluateCommand({ command: c, state: fresh(), host: calm, rules, tags: await tagFacts(c, rules, run) });
  for (const c of ['git tag -f m4-old-a d4759d4', 'git tag -d m4-old-a m4-old-b', 'git status --short | head -3; git tag -f m4-old-a d4759d4 >/dev/null', 'git -C /r tag --delete scratch'])
    assert.equal((await decideWith(c)).action, 'allow', c);
  assert.ok(calls.includes('git -C . ls-remote --tags upstream refs/tags/m4-old-a'), 'every remote is asked');
  for (const c of ['git tag -f shared', 'git tag -d flaky', 'git tag -f v1.2.0', 'git tag -d 1.0.0', 'git tag scratch', 'git tag -a -f x -m y', 'git tag -f m4 && npm version patch', "ssh h 'git tag -d x'", 'git tag -f $T',
    'git tag -f m4-old-a && git push origin m4-old-a', 'git tag -f m4-old-a && git push --tags', 'git tag -d m4-old-a && gh release create m4-old-a', 'git tag -f m4-old-a && gh api -X POST repos/o/r/git/refs -f ref=refs/tags/m4-old-a'])
    assert.equal((await decideWith(c)).rule, 'release', c);
});

test('a secret tool asked only for its usage is not a secret read (G24)', () => {
  for (const c of ['command -v bws op secret-tool; bws secret get --help 2>&1 | head -30', 'bws secret get -h', 'bw help get', 'op help read', 'gh auth token --help', 'printenv --help'])
    assert.equal(outcome(c, { state: { reminded: new Set(['read']) } }), 'allow', c);
  for (const c of ['bws secret get x', 'bws secret get x | grep --help', 'bws secret list && echo --help', 'grep -h TOKEN .env', 'bws secret get x; bws --help', 'env | sort',
    // Review of #207: a file reader prints the file whatever `--help` says, and a flag's value is no help request.
    'cat .env --help', 'head .env --help', 'cat ~/.ssh/id_rsa --help', 'cat .netrc --help', 'source .env --help', 'gh auth token --hostname --help'])
    assert.equal(outcome(c), 'ask:secrets', c);
});

test('pureRead: plain reads of non-secret files only (G24)', () => {
  for (const c of ['sed -n 36,56p a/b.md', 'sed -n 5p f', 'cat a b', 'head -n 5 f', 'tail -20 f', 'cd r && cat f', 'less docs/x.md'])
    assert.equal(pureRead(c), true, c);
  for (const c of ["sed -n 's/a/b/w o' f", 'sed -n 1,5p', 'sed 1p f', 'cat', 'cat -', 'cat a > b', 'cat a | sh', 'cat "a b"', 'cat $F', 'cat *.md', 'cat .env', 'cat .env.local', 'cat ~/.netrc',
    'head ~/.ssh/known_hosts', 'cat k.pem', 'cat my-secrets.txt', 'cat token.go', 'cat /dev/zero', 'cd ~/.ssh && cat config', 'cd a; cat f', 'cd a && cd b && cat f', 'grep x f', 'cat a && rm b',
    // Review of #207: outside the working tree goes to the harness's own prompt, and more secret names.
    'cd /r && cat f', 'cat /etc/hosts', 'cat ~/.config//gh/hosts.yml', 'cd ~/.config/ && cat gh/hosts.yml', 'cat //proc/self/environ', 'cd / && cat proc/self/environ',
    'cat a/../b', 'cat a//b', 'cat ~/.codex/auth.json', 'cat terraform.tfstate', 'cat prod.tfvars', 'cat prod.env', 'cat .git/config', 'cat .zsh_history',
    // Round 2: Windows drives and PowerShell's env: drive, and the cd dir joined to the path.
    'cat C:/Users/me/.config/glab-cli/config.yml', 'more C:/Users/me/AppData/Roaming/gh/hosts.yml', 'cd C:/Users/me && cat .claude.json', 'cat env:ANTHROPIC_API_KEY', 'cat a\\b', 'cd .config && cat gh/hosts.yml'])
    assert.equal(pureRead(c), false, c);
});

test('F4 cmdClass: a rule maps to its family, a command to its program family; never command text', () => {
  for (const group of ['skills', 'files', 'deny', 'risky']) for (const r of rules[group]) assert.notEqual(cmdClass(r.id, ''), 'other', r.id);
  assert.equal(cmdClass('host', ''), 'host');
  assert.equal(cmdClass('rm', 'rm -rf x'), 'delete');
  assert.equal(cmdClass('secrets', ''), 'secrets');
  assert.equal(cmdClass('no-such-rule', ''), 'other');
  assert.equal(cmdClass(null, 'cd /x && git status'), 'git');
  assert.equal(cmdClass(null, 'FOO=1 /usr/bin/make check'), 'build');
  assert.equal(cmdClass(null, 'some-private-tool --flag'), 'other');
  assert.equal(cmdClass(null, ''), 'other');
  for (const c of ['constructor x', 'toString', '__proto__ a', 'hasOwnProperty']) assert.equal(cmdClass(null, c), 'other', c);
  assert.equal(cmdClass('constructor', ''), 'other');
});

test('factory run: a command naming the approval label is denied unless it only reads', () => {
  const run = (command, factory = { approval: 'agent-ok' }) => evaluateCommand({ command, state: fresh(), host: calm, factory, rules });
  for (const c of [
    // Adding, in every spelling.
    'gh issue edit 7 --add-label agent-ok',
    'gh issue edit 7 --add-label "needs-owner, Agent-OK"',
    'gh pr edit 3 --add-label=agent-ok',
    'gh issue create -t x -l agent-ok',
    'gh issue create -t x -lagent-ok',
    'gh issue create -t x -l=agent-ok',
    "gh issue edit 7 --add-label agent-o'k'",
    'gh issue edit 7 --add-label agent\\-ok',
    'gh issue edit 7 --body "a; b" --add-label agent-ok',
    'gh issue edit 7 --title "x | y" --add-label agent-ok',
    'gh issue -R o/r edit 7 --add-label agent-ok',
    'gh issue edit 7 --add-label "$(echo agent-ok)"',
    'gh api repos/o/r/issues/7/labels -f "labels[]=agent-ok"',
    'gh api repos/o/r/issues/7/labels -f labels[]=agent-ok -H "X: --method GET"',
    'gh api -X GET -X POST repos/o/r/issues/7/labels -f labels[]=agent-ok',
    'gh api -X GET repos/o/r/issues/7/labels -f labels[]=agent-ok',
    'gh api repos/o/r/issues/7/labels -f labels[]=agent-ok -f note=/comments',
    'gh api repos/o/r/issues/7/labels -f=labels[]=agent-ok',
    'gh api repos/o/r/issues/7/labels -flabels[]=agent-ok',
    'gh api repos/o/r/issues/7/labels -iflabels[]=agent-ok',
    'gh api -XPUT repos/o/r/issues/7/labels -f labels[]=agent-ok',
    'gh api -X POST repos/o/r/labels -f name=agent-ok',
    'bash -c "gh issue edit 7 --add-label agent-ok"',
    'eval "gh issue edit 7 --add-label agent-ok"',
    // Every command position: substitutions, assignments, separators, wrappers.
    'X=$(gh issue edit 7 --add-label agent-ok)',
    'URL="$(gh issue create -t t -b b --label agent-ok)"',
    'export URL=$(gh pr create --label agent-ok -t t -b b)',
    'local u="$(gh issue create --label agent-ok -t t -b b)"',
    'X=`gh issue edit 7 --add-label agent-ok`',
    'R=$(gh api -X POST repos/o/r/issues/7/labels -f labels[]=agent-ok)',
    'echo "$(gh -R o/r issue edit 7 --add-label agent-ok)"',
    'X=$(cd x && gh issue edit 7 --add-label agent-ok)',
    'cat <(gh issue edit 7 --add-label agent-ok)',
    'cd x; gh issue edit 7 --add-label agent-ok',
    'true && gh pr edit 3 --add-label agent-ok',
    'false || gh issue edit 7 --add-label agent-ok',
    'echo x | gh issue edit 7 --add-label agent-ok',
    'echo 7 | xargs gh issue edit --add-label agent-ok',
    'env A=1 gh issue edit 7 --add-label agent-ok',
    'command gh issue edit 7 --add-label agent-ok',
    'time gh issue edit 7 --add-label agent-ok',
    'sudo gh issue edit 7 --add-label agent-ok',
    'GH=gh; $GH issue edit 7 --add-label agent-ok',
    'curl -X POST -d \'{"labels":["agent-ok"]}\' https://api.github.com/repos/o/r/issues/7/labels',
    // Flags after a substitution (round 4).
    'gh issue edit $(gh issue list --json number -q .[0].number) --add-label agent-ok',
    'gh pr edit $(gh pr view --json number -q .number) --add-label agent-ok',
    'gh issue edit `cat n` --add-label agent-ok',
    'gh issue edit 7 --repo $(git remote get-url origin) --add-label agent-ok',
    'gh issue create --title $(date +%F) --label agent-ok -b b',
    'gh pr create -t $(git branch --show-current) -b b --label agent-ok',
    'gh issue create --title t --body $(cat b) --label agent-ok',
    'gh issue edit $((N+1)) --add-label agent-ok',
    'gh api -X POST repos/o/r/issues/$(cat n)/labels -f labels[]=agent-ok',
    // Removing is the owner's too; text that names the label fails closed.
    'gh issue edit 7 --remove-label agent-ok',
    'gh issue edit 7 --add-label needs-grooming --remove-label agent-ok',
    'gh api -X DELETE repos/o/r/issues/7/labels/agent-ok',
    'gh issue comment 7 --body "please re-apply agent-ok"',
    'gh api repos/o/r/issues/7/comments -f body="please re-apply agent-ok"',
    'git commit -m "docs: gh issue edit --add-label agent-ok is denied"',
    'gh issue create --label bug --title "support agent-ok"',
    // Anything but one plain gh read fails closed, even a read: piped, chained, substituted, wrapped, escaped.
    'L=$(gh issue list --label agent-ok)',
    'gh issue list --label agent-ok | jq length',
    'gh issue list --label agent-ok > out.json',
    'gh issue list --label agent-ok && gh issue edit 7 --add-label agent-ok',
    'grep -rn agent-ok .factory/config.yaml',
    'gh issue view 7 --web --json labels -q \'.labels[] | select(.name == "agent-ok")\'',
    'gh pr view 3 -cw -q \'"agent-ok"\'',
    'GH_BROWSER=x gh issue view 7 --json labels -q \'"agent-ok"\'',
    'gh api repos/o/r/issues/7/labels * --jq \'"agent-ok"\'',
    'gh issue view 7 --json labels -q \'"agent-ok"\' *',
    'gh issue list --label agent-ok --search "$(gh issue edit 7 --add-label agent-ok)"',
    'gh api repos/o/r/issues/7/labels --jq "agent-ok" --slurpx',
    'gh api repos/o/r/issues/7/labels -z --jq \'"agent-ok"\'',
    'gh issue list --label agent-ok\ngh issue edit 7 --add-label agent-ok',
    'gh issue list --label agent-ok # \' ; gh issue edit 7 --add-label agent-ok',
    // Round 5: escapes, ANSI-C quotes, comments, prefixes, exec flags.
    'echo "a \\"b\\"" && gh issue edit 7 --add-label agent-ok',
    'echo "\\"" ; gh issue edit 7 --add-label agent-ok ; echo "\\""',
    'echo $\'\\\'\' ; gh issue edit 7 --add-label agent-ok ; echo $\'\\\'\'',
    'echo x #"\ngh issue edit 7 --add-label agent-ok\n#"',
    'gh issue view "\'$" ; gh issue edit 7 --add-label agent-ok ; echo \'\'',
    'GH_BROWSER=\'sh -c "gh issue edit 7 --add-label agent-ok" x\' gh issue view 7 --web',
    'd=$; y="a[${d}(gh issue edit 7 --add-label agent-ok)]"; [[ 1 -eq y ]]',
    'printf \'gh issue edit 7 --add-label agent-ok\' > s; rg --pre sh -e x s',
    // A body the guard cannot read, sent to labels or issues, with no label in sight.
    'echo "\\"" ; gh api repos/o/r/issues/7/labels --input b.json ; echo "\\""',
    'gh api repos/o/r/issues/7/labels --in"put" b.json',
    // Round 6: a flag the shell rebuilds by expansion; any `gh api` the guard cannot read as plain.
    "gh api repos/o/r/issues/7/labels --in$'p'ut b.json",
    'gh api repos/o/r/issues/7/labels --in${X}put b.json',
    'gh api repos/o/r/issues/7/labels --in$(printf p)ut b.json',
    "gh api repos/o/r/issues/7/labels -F labels[]=$'@'l.txt",
    "gh $'a'pi repos/o/r/issues/7/labels --input b.json",
    'gh "$X" repos/o/r/issues/7/labels',
    'cat b.json | gh api repos/o/r/issues/7/labels --input -',
    'git push && gh -R o/r api repos/o/r/issues/7/labels -X POST -F labels[]=@l.txt',
    'gh api repos/{owner,x}/r/issues/7/labels/agent-ok',
    // Round 7: a redirection glued to gh, zsh `=gh`, a Windows path to gh.exe.
    "gh>/dev/null api repos/o/r/issues/7/labels --in$'p'ut b.json",
    "gh</dev/null api repos/o/r/issues/7/labels --in$'p'ut b.json",
    "gh>&2 api repos/o/r/issues/7/labels -F labels[]=$'@'l.txt",
    "=gh api repos/o/r/issues/7/labels --in$'p'ut b.json",
    '& "C:\\Program Files\\GitHub CLI\\gh.exe" api repos/o/r/issues/7/labels --input b.json',
    'EDIT=$(gh api graphql -F n=7 -F owner=o -F name=r --jq .data -f query=\'query{viewer{login}}\')',
    'gh api -X POST repos/o/r/issues/7/labels --input body.json',
    'gh api -X PATCH repos/o/r/issues/7 --input body.json',
    'gh api repos/o/r/issues/7/labels -F labels[]=@l.txt',
    'gh api repos/o/r/issues/7/labels -F=labels[]=@l.txt',
    'gh api repos/o/r/issues/7/labels --field labels[]=@l.txt',
    'gh api -X POST repos/o/r/issues/7/labels?x=1 --input body.json',
    'gh api repos/o/r/issues --input body.json',
    'gh api -X POST repos/o/r/issues -F labels[]=@l.txt -f title=x',
    'gh api -X PATCH repos/o/r/issues/7 --input body.json -f x=/comments',
    'gh api -X PATCH repos/o/r/issues/7 -F body=@b.md',
    'R=$(gh api repos/o/r/issues/7/labels --input b.json)',
    'R=$(gh api "repos/o/r/issues/7/labels?x=1" -X PUT --input b.json)',
    'gh api repos/o/r/issues/$(cat n)/labels --input b.json',
    'gh api repos/o/r/issues/7/labels $(echo --input) b.json',
  ]) {
    const d = run(c);
    assert.equal(d.action, 'deny', c);
    assert.equal(d.rule, 'factory-approval', c);
  }
  for (const c of [
    'gh issue list --label agent-ok',
    'gh issue list --state open --label agent-ok --json number,title,url,labels',
    'gh issue list --state closed --label agent-ok --search "closed:>=2026-10-01" --json number,title,url,closedAt',
    'gh issue view 7 --json labels --jq \'.labels[].name == "agent-ok"\'',
    'gh -R o/r issue list --label Agent-OK',
    'gh pr view 3 --json labels -q \'.labels[] | select(.name == "agent-ok")\'',
    'gh api repos/o/r/labels/agent-ok',
    'gh api --method=get repos/o/r/labels/agent-ok',
    'gh api -XGET repos/o/r/issues/7/labels --jq \'.[] | select(.name == "agent-ok")\'',
    'gh api "repos/{owner}/{repo}/issues/7/timeline" --paginate --jq \'.[] | select(.label.name == "agent-ok") | "\\(.event) \\(.actor.login)"\'',
    'gh pr status',
    // No label named, and not an unreadable body to labels or issues.
    'gh issue edit 7 --add-label needs-grooming',
    'gh issue edit 7 --add-label needs-owner',
    'gh issue edit 7 --add-label agent-ok-not',
    'gh issue edit 7 --add-label not-agent-ok',
    'gh issue edit 7 --add-label agent-oks',
    'grep -rn agent-okay .factory/config.yaml',
    'gh issue comment 7 --body-file c.md',
    'gh api -X PATCH "repos/{owner}/{repo}/issues/comments/123" -F body=@c.md',
    'gh api -X PUT repos/o/r/contents/a.md --input body.json',
    'gh api graphql -F n=7 -F owner=o -F name=r --jq .data -f query=\'query{viewer{login}}\'',
    'gh api user --jq .login',
    'gh api repos/o/r/issues/7/labels',
    'gh api repos/{owner}/{repo}/labels/agent-ok',
  ]) {
    assert.equal(run(c).action, 'allow', c);
  }
  // Not plain, but no `gh api` and no label: ship and land shapes are not the factory rule's (other rules may still ask for a skill).
  for (const c of ['git push && gh pr create -t "fix: x" -b y', 'gh pr create -t "fix: x" --body "$(cat f)"', 'URL=$(gh pr create -t "fix: x" -b y)', 'gh pr checks --watch; gh pr merge --auto --squash', 'gh -R o/r pr list | head -5']) {
    assert.notEqual(run(c).rule, 'factory-approval', c);
    assert.equal(touchesApprovalLabel(c, 'agent-ok'), false, c);
  }
  assert.equal(run('gh issue edit 7 --add-label ready', { approval: 'ready' }).action, 'deny', 'a configured label');
  assert.equal(run('gh issue edit 7 --add-label agent-ok', null).action, 'allow', 'no factory run: allowed');
});

test('factory run: the takeover label is denied like the approval label, reads pass', () => {
  const run = (command, factory = { approval: 'agent-ok', takeover: 'factory-takeover' }) => evaluateCommand({ command, state: fresh(), host: calm, factory, rules });
  for (const c of [
    'gh issue edit 7 --add-label factory-takeover',
    'gh issue edit 7 --remove-label Factory-Takeover',
    "gh issue edit 7 --add-label 'factory-take'over",
    'gh api repos/o/r/issues/7/labels -f labels=factory-takeover',
    'gh api -X DELETE repos/o/r/issues/7/labels/factory-takeover',
    'gh issue list --label factory-takeover | head -1',
  ]) {
    const d = run(c);
    assert.equal(d.action, 'deny', c);
    assert.equal(d.rule, 'factory-takeover', c);
    assert.match(d.reason, /takeover label/, c);
  }
  for (const c of ['gh issue list --label factory-takeover --json number', 'gh issue view 7 --json labels', 'gh issue edit 7 --add-label factory-claimed']) {
    assert.equal(run(c).action, 'allow', c);
  }
  assert.equal(run('gh issue edit 7 --add-label hand-over', { approval: 'agent-ok', takeover: 'hand-over' }).rule, 'factory-takeover', 'a configured label');
  assert.equal(run('gh issue edit 7 --add-label factory-takeover', null).action, 'allow', 'no factory run: allowed');
});

test('factory run with a config the guard could not read: every label change is denied, reads pass', () => {
  const unsure = { approval: 'agent-ok', takeover: 'factory-takeover', unsure: true, extra: ['go-ahead'] };
  const run = (command, factory = unsure) => evaluateCommand({ command, state: fresh(), host: calm, factory, rules });
  for (const c of [
    'gh issue edit 7 --add-label go-ahead',
    'gh issue edit 7 --add-label needs-owner',
    'gh issue create -t x -l anything',
    'gh api repos/o/r/issues/7/labels -f labels=x',
    'gh label edit x --name y',
    'L=go-ahead; gh issue edit 7 --add-label "$L"',
    "gh issue edit 7 --add-lab''el x",
    'gh issue edit 7 --add-lab"e"l x',
    'gh issue edit 7 --add-lab\\el x',
  ]) {
    const d = run(c);
    assert.equal(d.action, 'deny', c);
    assert.equal(d.rule, 'factory-config', c);
  }
  for (const c of ['gh issue view 7 --json labels', 'gh issue list --label needs-owner --json number', 'git status']) {
    assert.equal(run(c).action, 'allow', c);
  }
  assert.notEqual(run('gh pr create -t "fix: x" -b y').rule, 'factory-config', 'no label: not this rule');
  assert.equal(run('gh issue edit 7 --add-label needs-owner', { approval: 'agent-ok', takeover: 'factory-takeover' }).action, 'allow', 'a readable config: other labels pass');
});

test('factory run: the label check never throws and fails fast on a hang', () => {
  // In a child with a timeout, so a check that loops forever fails here in seconds instead of hanging the suite.
  const script = `
    import { touchesApprovalLabel } from ${JSON.stringify(new URL('./engine.mjs', import.meta.url).href)};
    const parts = ['gh', 'api', 'issue', 'edit', 'view', '-f', '-F=', '-fx=@', '-XPOST', '--input', '--jq', 'labels', 'agent-ok', '$(', '$\\'', '\`', '(', ')', '"', "'", '\\\\', '\\\\"', ';', '&&', '|', '#', '\\n', '\\0', '*', '=', 'X=', 'bash', '-c', ' ', 'jq'];
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    const seen = new Set(), lengths = new Set();
    for (let n = 0; n < 20000; n++) {
      const length = next() % 40;
      lengths.add(length);
      const command = Array.from({ length }, () => { const p = parts[next() % parts.length]; seen.add(p); return p; }).join(next() % 2 ? ' ' : '');
      touchesApprovalLabel(command, 'agent-ok');
    }
    if (lengths.size !== 40) throw new Error('the generator skipped lengths: ' + lengths.size);
    if (seen.size !== parts.length) throw new Error('the generator skipped parts: ' + parts.filter((p) => !seen.has(p)).join(' '));
    for (const odd of ['gh "x', "gh 'x", 'gh issue view "agent-ok', "gh api '", 'gh \\\\', '"'.repeat(100000) + 'agent-ok', "'".repeat(100001) + 'agent-ok', '$(gh '.repeat(20000) + 'agent-ok']) touchesApprovalLabel(odd, 'agent-ok');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10000, encoding: 'utf8' });
  assert.equal(r.signal, null, 'timed out');
  assert.equal(r.status, 0, r.stderr);
});
