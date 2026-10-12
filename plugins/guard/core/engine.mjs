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

// The literal subject of `git commit -m` / `gh pr create --title`, or null when it cannot be read statically
// (heredoc, $(...), no -m). ponytail: first -m only, no shell parser; unreadable forms are allowed.
const QUOTED = `("(?:[^"\\\\$\`]|\\\\.)*"|'[^']*')`;
export function titleOf(command) {
  const code = executable(command);
  const re = /\bgit\s+commit\b/.test(code)
    ? new RegExp(`\\bgit\\s+commit\\b[^\\n|;&]*?\\s(?:-[a-zA-Z]*m|--message)[\\s=]*${QUOTED}`)
    : /\bgh\s+pr\s+create\b/.test(code)
      ? new RegExp(`\\bgh\\s+pr\\s+create\\b[^\\n|;&]*?\\s(?:--title|-t)[\\s=]*${QUOTED}`)
      : null;
  const m = re && command.match(re);
  return m ? m[1].slice(1, -1).split('\n')[0].trim() : null;
}

export function badTitle(command, rules) {
  const title = titleOf(command);
  if (title === null) return null;
  const re = new RegExp(`^(${rules.titles.types.join('|')})(\\([a-z0-9._/-]+\\))?!?: [a-z]`);
  return re.test(title) ? null : title;
}

const hit = (rules, command) => rules.find((r) => new RegExp(r.match, 'i').test(executable(command)));

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

// Git facts for one removal target, through an injected `run(argv) -> stdout | null` (null on failure).
// Undefined when the target is not the root of a linked worktree (the main checkout never qualifies).
// "Safe" = clean tree and every commit on some remote ref (pushed, or merged into origin's default branch).
// ponytail: a squash-merged branch whose remote ref was pruned counts as unpushed and still asks.
export async function worktreeFact(path, run) {
  const git = (...args) => Promise.resolve().then(() => run(['git', '-C', path, ...args])).catch(() => null);
  const rp = await git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-prefix');
  if (rp == null) return undefined;
  const [gitDir, commonDir, prefix = ''] = rp.split(/\r?\n/);
  if (!gitDir || gitDir === commonDir || prefix !== '') return undefined;
  const [status, ahead] = await Promise.all([git('status', '--porcelain'), git('rev-list', '--count', 'HEAD', '--not', '--remotes')]);
  if (status == null || ahead == null || !/^\d+\s*$/.test(ahead)) return { safe: false, why: 'git check failed' };
  const why = [Number(ahead) && `${Number(ahead)} unpushed commit${Number(ahead) > 1 ? 's' : ''}`, status.trim() && 'dirty tree'].filter(Boolean);
  return { safe: !why.length, why: why.join(', ') };
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

export function evaluateCommand({ command, loadedSkills = new Set(), state, host = {}, env = {}, worktrees = {}, rules }) {
  // Hard denies come first and fire every time, like the title guard.
  const denied = hit(rules.deny ?? [], command)
  if (denied) return { action: 'deny', rule: denied.id, reason: denied.why }

  const exempt = safeRemoval(command, rules, env, worktrees);
  const risky = rules.risky.find((r) => new RegExp(r.match, 'i').test(executable(command)) && !(exempt && REMOVAL.has(r.id)));
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
  const { loadCap, cpuPercentCap, freeFloorGb } = rules.host;
  const strained = (host.load1 ?? 0) > loadCap || (host.cpuPercent ?? 0) > cpuPercentCap || (host.freeGb ?? Infinity) < freeFloorGb;
  if (heavy && strained && !state.reminded.has('host')) {
    state.reminded.add('host');
    return {
      action: 'deny',
      rule: 'host',
      reason:
        `The host is strained (${host.load1 != null ? `load ${host.load1}` : `cpu ${host.cpuPercent}%`}, ${host.freeGb} GB free; caps ${host.load1 != null ? loadCap : `${cpuPercentCap}%`} / ${freeFloorGb} GB). ` +
        'Load the `host-hygiene` skill, use the repo\'s scripts/host/heavy.sh if it has one, or wait and retry.',
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
  return { action: 'allow' };
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
  return rules.risky.some((r) => new RegExp(r.match, 'i').test(executable(command)));
}

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
