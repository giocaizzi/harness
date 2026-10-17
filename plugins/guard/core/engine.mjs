// Shared rule engine for the Claude Code mod and the Copilot adapters.
// Pure functions: adapters gather facts (command, loaded skills, host, usage) and
// apply the decision. `state.reminded` (a Set) is mutated: each rule fires once
// per session ("remind once, then let it through").

const bare = (skill) => skill.split(':').pop();

// Rules match what a command would run, not text it carries: heredoc bodies and quoted strings
// (commit messages, echo, grep patterns, file contents) are blanked, except the string after `-c`.
// ponytail: a $(...) inside double quotes is blanked too; a real shell parser if that ever matters.
export function executable(command) {
  return command
    .replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1')
    .replace(/(-c\s+)?("(?:[^"\\]|\\.)*"|'[^']*')/g, (m, c) => (c ? m : '""'));
}

// The literal subject of `git commit -m` or of a PR/MR title flag, or null when it cannot be read statically
// (heredoc, $(...), no flag). ponytail: first flag only, no shell parser; unreadable forms are allowed.
const QUOTED = `("(?:[^"\\\\$\`]|\\\\.)*"|'[^']*')`;
const TITLED = [
  [String.raw`\bgit\s+commit\b`, '-[a-zA-Z]*m|--message'],
  [String.raw`\bgh\s+pr\s+create\b`, '--title|-t'],
  [String.raw`\bglab\s+mr\s+(?:create|update)\b`, '--title|-t'],
  [String.raw`\baz\s+repos\s+pr\s+(?:create|update)\b`, '--title'], // az's -t is --target-branch
];
export function titleOf(command) {
  const code = executable(command);
  const t = TITLED.find(([cmd]) => new RegExp(cmd).test(code));
  const m = t && command.match(new RegExp(`${t[0]}[^\\n|;&]*?\\s(?:${t[1]})[\\s=]*${QUOTED}`));
  return m ? m[1].slice(1, -1).split('\n')[0].trim() : null;
}

export function badTitle(command, rules) {
  const title = titleOf(command);
  if (title === null) return null;
  const re = new RegExp(`^(${rules.titles.types.join('|')})(\\([a-z0-9._/-]+\\))?!?: [a-z]`);
  return re.test(title) ? null : title;
}

const hit = (rules, command) => rules.find((r) => new RegExp(r.match, 'i').test(executable(command)));

// A risky rule's `raw` must also match the command as written (quoted text included).
const riskyMatch = (r, command) => new RegExp(r.match, 'i').test(executable(command)) && (!r.raw || new RegExp(r.raw, 'i').test(command));

// The deny rule a command hits, so adapters gather repo facts (the Python manager) only when one applies.
export const deniedBy = (command, rules) => hit(rules.deny ?? [], command);

// Targets of every recursive delete (`rm -r`, `Remove-Item -Recurse`, `git worktree remove --force`) in a command,
// as written. Redirections are dropped; quoted, $(...) or glob targets come through as-is and are judged unsafe later.
const REMOVAL = new Set(['rm', 'worktree-rm']);
export function removalTargets(command, rules) {
  const removes = rules.risky.filter((r) => REMOVAL.has(r.id)).map((r) => new RegExp(r.match, 'i'));
  return executable(command)
    .replace(/\d*[<>]+(&\d+|\s*[^\s;&|]+)/g, ' ')
    .split(/&&|\|\||[;|&\n]/)
    .filter((seg) => removes.some((re) => re.test(seg)))
    .flatMap((seg) => (/\b(?:rm|remove-item|worktree\s+remove)\b(.*)$/i.exec(seg)?.[1] ?? '').split(/\s+/))
    .filter((t) => t && !t.startsWith('-'));
}

// A temp path: strictly under /tmp, /private/tmp, /var/folders (macOS $TMPDIR) or a Windows user's AppData\Local\Temp.
// $TMPDIR, ${TMPDIR}, $env:TEMP, %TEMP% (and TMP) resolve through `env`; an unset variable, glob, `~`, `.`/`..`
// or shell syntax is not resolvable statically, so it is not a temp path. The temp dir itself is not either.
// ponytail: `/tmp/link/` with a trailing slash follows a planted symlink; resolve with realpath if that matters.
const TEMP_VAR = /^(?:\$\{?(TMPDIR|TEMP|TMP)\}?|\$env:(TEMP|TMP)|%(TEMP|TMP)%)(?=[\\/]|$)/i;
const UNIX_TEMP = /^\/(?:private\/)?(?:tmp|var\/folders)\/[^/]/;
const WINDOWS_TEMP = /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\/[^/]/i;
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
export function isTempPath(target, env = {}) {
  const path = target.replace(TEMP_VAR, (m, a, b, c) => env[(a || b || c).toUpperCase()] || m);
  if (/^~|[*?[\]{}$%`"'(),;<>|&!]/.test(path)) return false;
  const p = norm(path);
  if (p.split('/').some((s) => s === '.' || s === '..')) return false;
  const tempDirs = ['TMPDIR', 'TEMP', 'TMP'].map((k) => env[k] && norm(env[k]).toLowerCase());
  return (UNIX_TEMP.test(p) || WINDOWS_TEMP.test(p)) && !tempDirs.includes(p.toLowerCase());
}

// Git facts for one removal target, through an injected `run(argv, cwd?) -> stdout | null` (null on failure or timeout).
// Undefined when the target is not the root of a linked worktree (the main checkout never qualifies).
// "Safe" = clean tree and either every commit on some remote ref (pushed, or merged into origin's default branch)
// or HEAD contained in the head of a merged PR of its branch (squash merge with the remote branch deleted).
export async function worktreeFact(path, run) {
  const sh = (argv, cwd) => Promise.resolve().then(() => run(argv, cwd)).catch(() => null);
  const git = (...args) => sh(['git', '-C', path, ...args]);
  const rp = await git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-prefix', '--show-toplevel');
  if (rp == null) return undefined;
  const [gitDir, commonDir, prefix = '', top] = rp.split(/\r?\n/);
  if (!gitDir || gitDir === commonDir || prefix !== '') return undefined;
  const [status, ahead] = await Promise.all([git('status', '--porcelain'), git('rev-list', '--count', 'HEAD', '--not', '--remotes')]);
  if (status == null || ahead == null || !/^\d+\s*$/.test(ahead)) return { safe: false, why: 'git check failed' };
  const n = Number(ahead);
  if (n && !status.trim()) {
    const merged = await mergedPrHead(git, sh, top || path);
    if (merged === true) return { safe: true, why: '' };
    return { safe: false, why: `${n} unpushed commit${n > 1 ? 's' : ''} (${merged})` };
  }
  const why = [n && `${n} unpushed commit${n > 1 ? 's' : ''}`, status.trim() && 'dirty tree'].filter(Boolean);
  return { safe: !why.length, why: why.join(', ') };
}

// True when HEAD is contained in the head of a merged PR of the current branch (gh, run in the worktree),
// else why not. Any gh failure (missing, unauthenticated, offline, timeout) is a reason, so the delete asks.
async function mergedPrHead(git, sh, cwd) {
  const branch = (await git('branch', '--show-current'))?.trim();
  if (!branch) return 'no branch';
  const oid = await sh(['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--limit', '1', '--jq', '.[0].headRefOid // empty'], cwd);
  if (oid == null) return 'gh check failed';
  if (!oid.trim()) return 'no merged PR';
  return (await git('merge-base', '--is-ancestor', 'HEAD', oid.trim())) != null || 'HEAD not in the merged PR';
}

// Worktree facts for every non-temp removal target of a command: { [target]: { safe, why } }.
export async function worktreeFacts(command, env, rules, run) {
  const facts = {};
  for (const t of removalTargets(command, rules)) {
    if (isTempPath(t, env) || !/^[\w./\\@+=:,-]+$/.test(t)) continue;
    const f = await worktreeFact(t, run);
    if (f) facts[t] = f;
  }
  return facts;
}

// A removal is exempt when it has targets and every one is a temp path or a safe worktree.
function safeRemoval(command, rules, env, worktrees) {
  const targets = removalTargets(command, rules);
  return targets.length > 0 && targets.every((t) => isTempPath(t, env) || worktrees[t]?.safe === true);
}

// `python`: the Python manager of the repo in cwd ('uv', 'poetry', 'pipenv', 'pip'; null for none), for deny rules with `when`.
export function evaluateCommand({ command, loadedSkills = new Set(), state, host = {}, env = {}, worktrees = {}, python = null, rules }) {
  // Hard denies come first and fire every time, like the title guard. A `when` rule denies only in a repo
  // that adopted that manager; elsewhere it lets the command through with a once-per-session note.
  const denied = deniedBy(command, rules)
  if (denied && (!denied.when || denied.when === python)) return { action: 'deny', rule: denied.id, reason: denied.why }
  const note = denied && !state.reminded.has(denied.id) ? denied.id : null

  const exempt = safeRemoval(command, rules, env, worktrees);
  const risky = rules.risky.find((r) => riskyMatch(r, command) && !(exempt && REMOVAL.has(r.id)));
  if (risky) {
    const why = Object.entries(worktrees).filter(([, f]) => !f.safe).map(([t, f]) => `\nWorktree ${t}: ${f.why}`).join('');
    return { action: 'ask', rule: risky.id, command, reason: `Risky command (${risky.why}): ${command}${why}` };
  }

  const title = badTitle(command, rules);
  if (title !== null) {
    return {
      action: 'deny',
      rule: 'title',
      reason:
        `"${title}" is not a Conventional Commit header (${rules.titles.why}). ` +
        `Use \`type(scope): lowercase description\` with type in ${rules.titles.types.join(', ')}; footers (BREAKING CHANGE, Co-Authored-By) go in the body/PR description. Then retry.`,
    };
  }

  const heavy = hit(rules.heavy, command);
  const { loadCap, cpuPercentCap, freeFloorGb, wrapper } = rules.host;
  const strained = (host.load1 ?? 0) > loadCap || (host.cpuPercent ?? 0) > cpuPercentCap || (host.freeGb ?? Infinity) < freeFloorGb;
  // A command already run through the heavy wrapper waits for its slot and load on its own.
  if (heavy && strained && !new RegExp(wrapper).test(command) && !state.reminded.has('host')) {
    state.reminded.add('host');
    return {
      action: 'deny',
      rule: 'host',
      reason:
        `The host is strained (${host.load1 != null ? `load ${host.load1}` : `cpu ${host.cpuPercent}%`}, ${host.freeGb} GB free; caps ${host.load1 != null ? loadCap : `${cpuPercentCap}%`} / ${freeFloorGb} GB). ` +
        'Load the `host-hygiene` skill and run the command through its scripts/heavy.sh (scripts/heavy.ps1 on Windows; ' +
        'scripts/lease.sh or lease.ps1 for a simulator or emulator run), or the repo\'s own heavy wrapper if it ships one: ' +
        'it waits for a slot and for load instead of failing.',
    };
  }

  const loaded = new Set([...loadedSkills].map(bare));
  const rule = hit(rules.skills, command);
  if (rule && !rule.skills.some((s) => loaded.has(s)) && !state.reminded.has(rule.id)) {
    state.reminded.add(rule.id);
    return {
      action: 'deny',
      rule: rule.id,
      reason:
        `AGENTS.md requires a skill here (${rule.why}). Load ${rule.skills.map((s) => `\`${s}\``).join(' or ')} ` +
        'first, then retry the same command.',
    };
  }
  if (!note) return { action: 'allow' };
  state.reminded.add(note);
  const uses = python ? `This repo uses ${python}` : 'This directory has no uv project';
  return { action: 'allow', rule: note, context: `${uses}, so \`${note}\` is allowed here; uv is preferred where the repo adopts it.` };
}

export function usageLevel(percent, rules) {
  if (percent == null) return 'unknown';
  if (percent >= rules.usage.throttlePercent) return 'throttle';
  if (percent >= rules.usage.warnPercent) return 'warn';
  return 'ok';
}

// Spawning a subagent: deny once usage is at the throttle level, never before.
export function evaluateSpawn({ usagePercent, resetsAt, rules }) {
  const level = usageLevel(usagePercent, rules);
  if (level !== 'throttle') return { action: 'allow', level };
  // resetsAt: ISO string (Claude mods API) or epoch seconds (status line)
  const ms = typeof resetsAt === 'number' ? resetsAt * 1000 : Date.parse(resetsAt);
  const when = Number.isFinite(ms) ? ` (resets ${new Date(ms).toLocaleString()})` : '';
  return {
    action: 'deny',
    level,
    reason: `Plan usage is at ${Math.round(usagePercent)}%${when}. Do the work in this session instead of spawning subagents, or wait for the reset.`,
  };
}

// Adapters ask this before gathering host facts, so the (slow) uptime/df calls run only for heavy commands.
export function isHeavy(command, rules) {
  return rules.heavy.some((r) => new RegExp(r.match, 'i').test(executable(command)));
}

export function isRisky(command, rules) {
  return rules.risky.some((r) => riskyMatch(r, command));
}

// Where a hook cannot ask (Codex, opencode), the harness's own prompt rules ask for the risky rule's `prefixes`.
// True when such a rule surely covers the command: single-spaced plain words only, so the harness parses it
// into the same words and matches the prefix. Anything a shell expands or Codex declines to parse (`$`, globs,
// `~`, quotes, escapes, operators) is not, and is denied: Codex then skips its prompt rules.
const PLAIN_WORD = /^[\w./@%+=:,-]+$/;
export function nativeAsk(command, ruleId, rules) {
  const words = command.trim().split(' ');
  if (!words.every((w) => PLAIN_WORD.test(w))) return false;
  const prefixes = rules.risky.find((r) => r.id === ruleId)?.prefixes ?? [];
  return prefixes.some((p) => p.every((t, i) => words[i] === t));
}

// The Codex execpolicy file (`$CODEX_HOME/rules/`) that prompts for every risky prefix.
export const codexRules = (rules) =>
  rules.risky
    .flatMap((r) => (r.prefixes ?? []).map((p) => `prefix_rule(pattern = ${JSON.stringify(p)}, decision = "prompt", justification = ${JSON.stringify(`guard: ${r.why}`)})\n`))
    .join('');

// opencode `permission.bash` entries that ask for every risky prefix (its wildcard `x *` also matches `x`).
export const opencodeAsks = (rules) => Object.fromEntries(rules.risky.flatMap((r) => (r.prefixes ?? []).map((p) => [`${p.join(' ')} *`, 'ask'])));

// Blast radius: a read-only argv (no shell) that shows what a risky command would touch, or null.
// Only plain path tokens are passed through; anything with shell syntax gets no preview.
const SAFE_TOKEN = /^[\w./~@%+=:,-]+$/;

export function previewCommand(ruleId, command) {
  if (ruleId === 'reset') return ['git', 'status', '--short'];
  if (ruleId === 'force') return ['git', 'log', '--oneline', '-n', '10', 'HEAD..@{u}'];
  if (ruleId === 'rm') {
    const args = command.replace(/^.*?\brm\b/i, '').trim().split(/\s+/);
    const paths = args.filter((a) => !a.startsWith('-'));
    if (!paths.length || !paths.every((p) => SAFE_TOKEN.test(p))) return null;
    return ['du', '-sh', '--', ...paths];
  }
  return null;
}

// Append a preview (first 12 lines) to an ask reason.
export function withPreview(reason, output) {
  const lines = String(output ?? '').trim().split('\n').filter(Boolean);
  if (!lines.length) return reason;
  const more = lines.length > 12 ? `\n… ${lines.length - 12} more` : '';
  return `${reason}\nWould affect:\n${lines.slice(0, 12).join('\n')}${more}`;
}
