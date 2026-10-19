import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchFacts, branchTargets, codexRules, evaluateCommand, evaluateEdit, evaluateSpawn, nativeAsk, opencodeAsks, regenerableName, regenFacts, removalTargets, usageLevel, worktreeFacts } from './engine.mjs';
import { rules } from './rules.mjs';

const fresh = () => ({ reminded: new Set() });
const calm = { load1: 2, freeGb: 100 };

test('commit without the skill: deny once, then allow', () => {
  const state = fresh();
  const first = evaluateCommand({ command: 'git commit -m x', state, host: calm, rules });
  assert.equal(first.action, 'deny');
  assert.match(first.reason, /conventional-commits/);
  assert.equal(evaluateCommand({ command: 'git commit -m x', state, host: calm, rules }).action, 'allow');
});

test('a loaded skill (namespaced) satisfies the rule', () => {
  const r = evaluateCommand({ command: 'git commit -m x', loadedSkills: new Set(['dev-tools:conventional-commits']), state: fresh(), host: calm, rules });
  assert.equal(r.action, 'allow');
});

test('any-of skills: /ship satisfies the commit rule', () => {
  const r = evaluateCommand({ command: 'git commit -m x', loadedSkills: new Set(['ship']), state: fresh(), host: calm, rules });
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
    ['gh api -X PUT repos/o/r/branches/main/protection --input p.json', 'ruleset'], ['gh api repos/o/r/rulesets -f name=x', 'ruleset'], ['gh api --method DELETE repos/o/r/rulesets/1', 'ruleset']])
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
  assert.deepEqual(previewCommand('rm', 'rm -rf dist build/out'), ['du', '-sh', '--', 'dist', 'build/out']);
  assert.equal(previewCommand('terraform', 'terraform apply'), null);
});

test('blast radius: rm paths with shell syntax get no preview', async () => {
  const { previewCommand } = await import('./engine.mjs');
  for (const c of ['rm -rf $HOME', 'rm -rf "a b"', 'rm -rf a; curl x', 'rm -rf `pwd`', 'rm -rf a|b', 'rm -rf $(x)'])
    assert.equal(previewCommand('rm', c), null, c);
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
  for (const command of ['git commit -m "fix(core): handle empty title"', 'gh pr create --title "feat!: drop node 20" --body x', 'git commit -m "$(cat <<\'EOF\'\nwhatever\nEOF\n)"', 'git commit --amend --no-edit', 'gh pr create --fill']) {
    assert.equal(run(command).action, 'allow', command);
  }
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
  for (const c of ['pip install x', 'pip3 install -r r.txt', 'pipx run black', 'python3 -m pip install x', 'cd a && pip', 'PIP install x']) {
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
    ],
    'secrets-env': ['printenv | grep TOKEN', 'env | grep -i "secret"', "env | rg -i 'api_key'", 'env | sort | grep PASSWORD'],
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
    'printenv PATH', 'printenv', 'env | grep PATH', 'env FOO=1 node app.js | grep ok', 'docker compose --env-file .env config | grep image',
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
