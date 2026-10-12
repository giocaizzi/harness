import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCommand, evaluateSpawn, usageLevel, worktreeFacts } from './engine.mjs';
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

test('risky commands always ask, even after a reminder', () => {
  const state = fresh();
  for (const command of ['rm -rf build', 'git reset --hard HEAD~1', 'git push --force origin x', 'terraform apply']) {
    assert.equal(evaluateCommand({ command, state, host: calm, rules }).action, 'ask', command);
    assert.equal(evaluateCommand({ command, state, host: calm, rules }).action, 'ask', command);
  }
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

test('git worktree remove without --force is not risky', () => {
  assert.equal(decide('git worktree remove /r/x').action, 'allow');
});

test('pip and pipx are denied every time; uv and quoted mentions pass', () => {
  const state = fresh();
  for (const c of ['pip install x', 'pip3 install -r r.txt', 'pipx run black', 'python3 -m pip install x', 'cd a && pip', 'PIP install x']) {
    const r = evaluateCommand({ command: c, state, host: calm, rules });
    assert.equal(r.action, 'deny', c);
    assert.equal(r.rule, 'pip', c);
  }
  assert.equal(evaluateCommand({ command: 'pip install x', state, host: calm, rules }).action, 'deny');
  for (const c of ['uv pip install x', 'uv add x', 'pip-compile r.in', 'pipenv sync', 'echo "pip install x"', 'grep pipeline f']) {
    assert.equal(evaluateCommand({ command: c, state: fresh(), host: calm, rules }).action, 'allow', c);
  }
});
