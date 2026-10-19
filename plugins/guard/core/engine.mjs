// Shared rule engine for the Claude Code mod and the Copilot adapters.
// Pure functions: adapters gather facts (command, loaded skills, host, usage) and
// apply the decision. `state.reminded` (a Set) is mutated: each rule fires once
// per session ("remind once, then let it through").

import { analyze, units } from './shell.mjs';

const bare = (skill) => skill.split(':').pop();

// Rules match what a command would run, not text it carries: quoted strings (commit messages, echo, grep patterns)
// and heredoc bodies are blanked. What runs although it is written as data (a shell's -c string, eval, ssh's remote
// command, docker exec, a heredoc or echo piped into a shell, $(…) even inside double quotes) is read again by
// core/shell.mjs and added, one line per level. `remote: false` leaves out what runs on another host or in a
// container; `injected: false` leaves out a $(…) whose output only becomes a variable's value (`T="$(…)" cmd`).
// A command the guard cannot read (an encoded PowerShell command, base64 decoded into a shell) adds OPAQUE.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
export const OPAQUE = '<guard:opaque>';
const cache = new Map();
export function analysis(command) {
  if (!cache.has(command)) {
    if (cache.size > 200) cache.clear();
    cache.set(command, analyze(command));
  }
  return cache.get(command);
}
const levelCode = (a) => a.commands.map((c, i) => `${i && c.sep ? (c.sep === '\n' ? '\n' : ` ${c.sep} `) : ''}${c.code.trim()}`).join('');
function levels(a, opts, ctx = { remote: false, injected: false }) {
  const out = [levelCode(a)];
  for (const c of a.commands)
    for (const p of c.payloads) {
      const sub = { remote: ctx.remote || Boolean(p.remote), injected: ctx.injected || Boolean(p.injected) };
      if ((sub.remote && !opts.remote) || (sub.injected && !opts.injected)) continue;
      out.push(...levels(p.analysis, opts, sub));
    }
  return out;
}
export function executable(command, { remote = true, injected = true } = {}) {
  const a = analysis(command);
  return [...levels(a, { remote, injected }), ...(a.opaque ? [OPAQUE] : [])].join('\n');
}

// Git's global options sit between `git` and the subcommand (`git -C dir`, `-c k=v`, `--git-dir=…`, `--no-pager`) and
// would hide it from every `git <subcommand>` rule, so rules match with them removed; `gitDirs` keeps the `-C` dirs.
const GIT_VAL = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|"'])+`;
const GIT_GLOBALS = String.raw`(?<![\w./:@-])git((?:\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source)(?:=|\s+)${GIT_VAL}|-[\w-]+(?:=${GIT_VAL})?))+)(?=\s+[^\s-])`;
export const gitPlain = (code) => code.replace(new RegExp(GIT_GLOBALS, 'g'), 'git');
const gitDirs = (seg) => [...(new RegExp(GIT_GLOBALS).exec(seg)?.[1] ?? '').matchAll(/(?:^|\s)-C\s+(\S+)/g)].map((m) => m[1]);
// What rules match: the executable text with git's global options removed. A double-quoted word holding only a
// variable or a plain word (`"$TOKEN"`, `".env"`) is that word, so a rule can see it (SIMPLE_QUOTED, below).
const matchable = (command, opts) => gitPlain(executable(command.replace(SIMPLE_QUOTED, '$1'), opts));

// Every pipeline of a command at every level, with its code and its text as written: { code, raw, depth,
// siblings, host, top }, where `siblings` counts the commands at its level and `top` those of the whole command.
const KEYWORD = /^(?:do|done|then|fi|else|esac|\{|\})?$/;
function pipelines(command, { injected = true } = {}) {
  const a = analysis(command.replace(SIMPLE_QUOTED, '$1'));
  const count = (level) => level.commands.filter((c) => !KEYWORD.test(c.code.trim())).length;
  const top = count(a);
  const out = [];
  const walk = (level, ctx) => {
    let pipe = [];
    const groups = [];
    for (const c of level.commands) {
      if (pipe.length && c.sep !== '|' && c.sep !== '|&') (groups.push(pipe), (pipe = []));
      pipe.push(c);
    }
    if (pipe.length) groups.push(pipe);
    for (const p of groups) {
      out.push({ code: gitPlain(p.map((c) => c.code.trim()).join(' | ')), raw: p.map((c) => c.raw).join(' | '), depth: ctx.depth, siblings: count(level), host: ctx.host, top });
      for (const c of p)
        for (const pl of c.payloads) {
          if (pl.injected && !injected) continue;
          walk(pl.analysis, { depth: ctx.depth + 1, host: pl.host ?? ctx.host });
        }
    }
  };
  walk(a, { depth: 0, host: undefined });
  return out;
}
// A `pipeline` rule fires on one pipeline whose code matches, whose text matches `raw` and not `unless`.
const pipelineHit = (r, p) => riskyRe(r).test(p.code) && (!r.raw || new RegExp(r.raw, 'i').test(p.raw)) && !(r.unless && new RegExp(r.unless, 'i').test(p.raw));

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
  const t = TITLED.find(([cmd]) => new RegExp(cmd).test(matchable(command)));
  const m = t && gitPlain(command).match(new RegExp(`${t[0]}[^\\n|;&]*?\\s(?:${t[1]})[\\s=]*${QUOTED}`));
  return m ? m[1].slice(1, -1).split('\n')[0].trim() : null;
}

export function badTitle(command, rules) {
  const title = titleOf(command);
  if (title === null) return null;
  const re = new RegExp(`^(${rules.titles.types.join('|')})(\\([a-z0-9._/-]+\\))?!?: [a-z]`);
  return re.test(title) ? null : title;
}

const hit = (rules, command, opts) => rules.find((r) => new RegExp(r.match, 'i').test(matchable(command, opts)));

// A risky rule's `raw` must also match the command as written (quoted text included). `case` rules match
// case-sensitively; `skipInjected` rules do not look inside a value injected into a variable.
const riskyRe = (r) => new RegExp(r.match, r.case ? '' : 'i');
const riskyMatch = (r, command) =>
  r.pipeline
    ? pipelines(command, { injected: !r.skipInjected }).some((p) => pipelineHit(r, p))
    : riskyRe(r).test(matchable(command, { injected: !r.skipInjected })) && (!r.raw || new RegExp(r.raw, 'i').test(command));

// The deny rule a command hits, so adapters gather repo facts (the Python manager) only when one applies.
export const deniedBy = (command, rules) => hit(rules.deny ?? [], command);
// Where the denied command runs, relative to the cwd ('' for the cwd itself): `cd <uv repo> && pip install x` is
// judged by that repo's manager. Null when it cannot be known (an unfollowed cd) or it runs on another host.
export function deniedDir(command, rules, env = {}) {
  const rule = deniedBy(command, rules);
  if (!rule) return null;
  const at = segments(command, env).find(({ seg }) => new RegExp(rule.match, 'i').test(seg));
  if (!at || at.remote || at.dir.startsWith(UNKNOWN_DIR)) return null;
  return at.dir;
}

// `for VAR in w1 w2; do BODY; done` with only plain words in the list becomes BODY once per word, $VAR and ${VAR}
// replaced, so each removal target can be judged. The loop is found with quotes and heredoc bodies masked (same
// length), so a `for` or `done` inside a string never counts. Not expanded, so `$VAR` stays and asks: a list with
// globs, quotes or expansions, a body that names VAR otherwise (assigns, reads, unsets it) or holds another loop.
const LOOP = /(?<=^|[\s;&|(])for\s+([A-Za-z_]\w*)\s+in\s+([^;\n]*?)\s*[;\n]\s*do\s([\s\S]*?)[;\n]\s*done(?=[\s;&|)<>]|$)/dg;
const PLAIN_LIST = /^[\w./@%+=:,-]+(?:\s+[\w./@%+=:,-]+)*$/;
const LOOP_WORD = /(?:^|[\s;&|(])(?:for|while|until|select|do|done)(?=[\s;]|$)/;
export function expandLoops(command) {
  const masked = command
    .replace(HEREDOC, (m, head) => head + m.slice(head.length).replace(/\S/g, '_'))
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => m[0] + '_'.repeat(m.length - 2) + m[0]);
  let out = '';
  let at = 0;
  for (const m of masked.matchAll(LOOP)) {
    const [, name, list] = m;
    const [start, end] = m.indices[3];
    const body = command.slice(start, end);
    const ref = new RegExp(`(?<!\\\\)\\$(?:${name}(?!\\w)|\\{${name}\\})`, 'g');
    if (!PLAIN_LIST.test(list) || LOOP_WORD.test(masked.slice(start, end)) || new RegExp(`\\b${name}\\b`).test(body.replace(ref, ''))) continue;
    out += command.slice(at, m.index) + list.split(/\s+/).map((w) => body.replace(ref, () => w)).join('\n');
    at = m.index + m[0].length;
  }
  return out + command.slice(at);
}

// The simple commands of a command (after loop expansion, redirections dropped, git's global options removed), each
// with the directory it runs in. A relative path after `cd DIR` is in DIR, and after `git -C DIR` in DIR too. `cd` is
// followed only through plain `;`/`&&` chains with a plain DIR: after any other `cd`, or with a subshell, group, `||`,
// pushd or conditional in the command, the directory is UNKNOWN_DIR, which no check accepts.
// Paths are resolved the way the shell would, by position (owner decision D5): a leading `~` or `$HOME` from the
// environment, and `$NAME` from an assignment earlier in the same command (`NAME=/abs/path`, `NAME=$(mktemp -d)`,
// `export NAME=…`), the latest one winning. A prefix assignment (`NAME=v cmd`) holds for that command only, so it is
// never followed. An unset or external variable, `~user` or a value that is not a plain path stays as written and asks.
// A double-quoted word with no spaces or other expansions ("$TMPDIR/x", "$S") is that word: unquote it so the
// temp check can resolve it instead of seeing the blanked string.
const SIMPLE_QUOTED = /"((?:\$\{?\w+\}?)?[^"\s$`\\]*)"/g;
const UNKNOWN_DIR = '<cd?>';
const REMOTE_DIR = '<remote>';
const NO_TARGET = '<none>';
const CD = /(?:^|[\s({])(?:cd|chdir|set-location|sl)(?=\s|$)/i;
const PLAIN_CD = /^\s*(?:cd|chdir|set-location|sl)(?:\s+(\S+))?\s*$/i;
const PLAIN_DIR = /^[\w.@%+=:,\\/~][\w.@%+=:,\\/~-]*$/;
const BRANCHY = /[(){}]|\|\||(?:^|[\s;&|])(?:pushd|popd|push-location|pop-location|if|then|else|elif|fi|case|esac|for|while|until|do|done)(?=[\s;]|$)/i;
const ABSOLUTE = /^(?:[\\/]|[a-z]:|~|\$|%)/i;
const inDir = (dir, p) => (!dir || ABSOLUTE.test(p) ? p : `${dir}/${p}`);
const MKTEMP = /^\$\(mktemp(\s+-[dqu]+)*(\s+(-t|--tmpdir(=\S+)?)(\s+[\w.-]+)?)?\)$/;
const DECLARE = /^(?:export|declare|typeset|local|readonly)$/;
const VAR_REF = /^\$(?:\{(\w+)\}|(\w+))(?=[\\/]|$)/;
// `word` with a leading `~`, `$HOME` or `$NAME` resolved from `vars` (assignments so far) and `env`; else as written.
function expandPath(word, vars, env) {
  if (/^~(?=[\\/]|$)/.test(word)) return env.HOME ? env.HOME.replace(/[\\/]+$/, '') + word.slice(1) : word;
  const m = VAR_REF.exec(word);
  if (!m) return word;
  const name = m[1] ?? m[2];
  const value = name in vars ? vars[name] : name === 'HOME' ? env.HOME?.replace(/[\\/]+$/, '') : undefined;
  return value ? value + word.slice(m[0].length) : word;
}
// A command made only of assignments (`A=1 B=2`, `export A=1`): they persist, so later commands see them.
function assign(cmd, vars, env) {
  const words = cmd.words.filter((w, i) => !(i === 0 && DECLARE.test(w.val)));
  if (!words.length || !words.every((w) => /^[A-Za-z_]\w*=/.test(w.val))) return false;
  for (const w of words) {
    const name = w.val.slice(0, w.val.indexOf('='));
    const raw = w.raw.slice(w.raw.indexOf('=') + 1).replace(/^"([\s\S]*)"$/, '$1');
    const value = expandPath(w.val.slice(name.length + 1), vars, env);
    if (MKTEMP.test(raw)) vars[name] = '/tmp/mktemp.placeholder';
    else if (/^(?:[\\/]|[a-z]:[\\/])/i.test(value) && PLAIN_PATH.test(value)) vars[name] = value;
    else if (isTempPath(value, env)) vars[name] = value;
    else vars[name] = null;
  }
  return true;
}
// One level of commands (the top level, or a payload), each with its directory; payloads follow their command, in
// the directory it runs in (a remote payload starts in no known directory, without this machine's HOME). A command
// that hands its words to another host or a container (`ssh host rm -rf x`) is judged only through its payload.
// Each entry: { seg (redirections dropped), code, dir, remote, resolve(path) }.
function levelSegments(a, baseDir, remote, env, outer = {}) {
  const followCd = !BRANCHY.test(levelCode(a));
  const vars = { ...outer };
  let dir = baseDir;
  const out = [];
  for (const cmd of a.commands) {
    const seg = cmd.code.replace(/\d*[<>]+(&\d+|\s*[^\s;&|]+)/g, ' ');
    const snapshot = { ...vars };
    const resolve = (p) => expandPath(p, snapshot, env);
    if (assign(cmd, vars, env)) {
      // nothing runs
    } else if (CD.test(seg)) {
      const m = followCd && PLAIN_CD.exec(seg);
      const to = m && (m[1] === undefined ? env.HOME : resolve(m[1]));
      dir = to && PLAIN_DIR.test(to) && !/^~/.test(to) ? inDir(dir, to) : UNKNOWN_DIR;
    } else if (!cmd.payloads.some((p) => p.remote && p.kind !== 'subst')) {
      out.push({ seg: gitPlain(seg), code: cmd.code, dir: gitDirs(seg).map(resolve).reduce(inDir, dir), remote, resolve });
    }
    for (const p of cmd.payloads) {
      out.push(...(p.remote ? levelSegments(p.analysis, REMOTE_DIR, true, {}) : levelSegments(p.analysis, dir, remote, env, snapshot)));
    }
  }
  return out;
}
function segments(command, env = {}) {
  return levelSegments(analysis(expandLoops(command).replace(SIMPLE_QUOTED, '$1')), '', false, env);
}
const plainArgs = (rest) => rest.split(/\s+/).filter((t) => t && !t.startsWith('-'));
function findRoots(rest) {
  const roots = [];
  for (const t of rest.split(/\s+/).filter(Boolean)) {
    if (/^[-(!\\]/.test(t)) break;
    roots.push(t);
  }
  return roots;
}

// Targets of every recursive delete (`rm -r`, `Remove-Item -Recurse`, `find -delete`, `git worktree remove --force`)
// in a command, as written, each in its directory. Quoted, $(...) or glob targets come through as-is and are judged
// unsafe later; a delete with no target (`xargs rm -rf`) yields NO_TARGET, so it never rides on a safe one. A find's
// targets are its start paths, before the first option or expression.
const REMOVAL = new Set(['rm', 'find', 'worktree-rm']);
export function removalEntries(command, rules, env = {}) {
  const risky = (id) => riskyRe(rules.risky.find((r) => r.id === id));
  const removes = [...REMOVAL].map(risky);
  const entries = [];
  for (const { seg, dir, remote, resolve } of segments(command, env)) {
    if (!removes.some((re) => re.test(seg))) continue;
    const found = risky('find').test(seg)
      ? findRoots(/\bfind\b(.*)$/i.exec(seg)?.[1] ?? '')
      : plainArgs(/\b(?:rm|remove-item|ri|del|erase|rd|rmdir|worktree\s+remove)\b(.*)$/i.exec(seg)?.[1] ?? '');
    entries.push(...(found.length ? found : [NO_TARGET]).map((t) => ({ target: inDir(dir, resolve(t)), remote })));
  }
  return entries;
}
export const removalTargets = (command, rules, env) => removalEntries(command, rules, env).map((e) => e.target);
// Targets on this machine: facts (git, gh) are never gathered for another host's or a container's paths.
const localTargets = (command, rules, env) => removalEntries(command, rules, env).filter((e) => !e.remote).map((e) => e.target);

// Branches every `git branch -D` in a command deletes: { dir, name }, `dir` from `cd`/`git -C` ('' for the cwd).
export function branchTargets(command, rules, env = {}) {
  const re = riskyRe(rules.risky.find((r) => r.id === 'branch-delete'));
  return segments(command, env)
    .filter(({ seg, remote }) => re.test(seg) && !remote)
    .flatMap(({ seg, dir }) => {
      const names = plainArgs(/\bbranch\b(.*)$/.exec(seg)?.[1] ?? '');
      return (names.length ? names : [NO_TARGET]).map((name) => ({ dir, name }));
    });
}

// A temp path: strictly under /tmp, /private/tmp, the macOS per-user temp dir or a Windows user's AppData\Local\Temp.
// $TMPDIR, ${TMPDIR}, $env:TEMP, %TEMP% (and TMP) resolve through `env`; an unset variable, other glob, `~`, `.`/`..`
// or shell syntax is not resolvable statically, so it is not a temp path. The temp dir itself is not either.
// ponytail: `/tmp/link/` with a trailing slash follows a planted symlink; resolve with realpath if that matters.
const TEMP_VAR = /^(?:\$\{?(TMPDIR|TEMP|TMP)\}?|\$env:(TEMP|TMP)|%(TEMP|TMP)%)(?=[\\/]|$)/i;
// Under /var/folders only the per-user temp dir counts (`/var/folders/<a>/<b>/T/…`, its `C/` caches do not), and under
// /tmp not the sockets of tmux, X11 and ssh agents or macOS's own folders.
const UNIX_TEMP = /^\/(?:private\/)?(?:tmp\/(?!(?:tmux-|\.X11-unix|\.ICE-unix|ssh-|com\.apple\.|launchd-))[^/]|var\/folders\/[^/]+\/[^/]+\/T\/[^/])/;
const WINDOWS_TEMP = /^[a-z]:\/users\/[^/]+\/appdata\/local\/temp\/[^/]/i;
const norm = (p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
export function isTempPath(target, env = {}) {
  const path = target.replace(TEMP_VAR, (m, a, b, c) => env[(a || b || c).toUpperCase()] || m);
  // A `*`/`?` glob in the last segment stays inside its parent, so it is temp when the parent is. A leading dot is
  // refused: an old bash expands `.*` to `..`.
  const glob = /^(.+)[\\/]([\w*?-][\w.*?-]*)$/.exec(path);
  if (glob && /[*?]/.test(glob[2])) return isTempPath(glob[1], env);
  if (/^~|[*?[\]{}$%`"'(),;<>|&!]/.test(path)) return false;
  const p = norm(path);
  if (p.split('/').some((s) => s === '.' || s === '..')) return false;
  const tempDirs = ['TMPDIR', 'TEMP', 'TMP'].map((k) => env[k] && norm(env[k]).toLowerCase());
  // Strictly under the environment's own temp dir counts too, whatever its layout (Linux, a CI runner).
  const underTemp = tempDirs.some((d) => d && p.toLowerCase().startsWith(`${d.replace(/\/$/, '')}/`));
  return (UNIX_TEMP.test(p) || WINDOWS_TEMP.test(p) || underTemp) && !tempDirs.includes(p.toLowerCase());
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
  const [all, ahead] = await Promise.all([git('status', '--porcelain', '--ignored'), git('rev-list', '--count', 'HEAD', '--not', '--remotes')]);
  if (all == null || ahead == null || !/^\d+\s*$/.test(ahead)) return { safe: false, why: 'git check failed' };
  // Ignored files are normally regenerable, but a local secret (`.env`, `*.key`) exists nowhere else.
  const lines = all.split(/\r?\n/).filter(Boolean);
  const status = lines.filter((l) => !l.startsWith('!!')).join('\n');
  const secrets = lines.filter((l) => l.startsWith('!!')).map((l) => l.slice(3).replace(/\/$/, '')).filter((f) => f.split('/').some((seg) => NEVER_REGEN.test(seg)));
  if (secrets.length) return { safe: false, why: `ignored secrets: ${secrets.slice(0, 3).join(', ')}` };
  const n = Number(ahead);
  if (n && !status.trim()) {
    const merged = await mergedPrHead(git, sh, top || path, (await git('branch', '--show-current'))?.trim());
    if (merged === true) return { safe: true, why: '' };
    return { safe: false, why: `${unpushed(n)} (${merged})` };
  }
  const why = [n && unpushed(n), status.trim() && 'dirty tree'].filter(Boolean);
  return { safe: !why.length, why: why.join(', ') };
}
const unpushed = (n) => `${n} unpushed commit${n > 1 ? 's' : ''}`;

// True when `rev` is contained in the head of a merged PR of `branch` (gh, run in the repo at `cwd`), else why not.
// Any gh failure (missing, unauthenticated, offline, timeout) is a reason, so the delete asks.
async function mergedPrHead(git, sh, cwd, branch, rev = 'HEAD') {
  if (!branch) return 'no branch';
  const oid = await sh(['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--limit', '1', '--jq', '.[0].headRefOid // empty'], cwd);
  if (oid == null) return 'gh check failed';
  if (!oid.trim()) return 'no merged PR';
  return (await git('merge-base', '--is-ancestor', rev, oid.trim())) != null || `${rev === 'HEAD' ? 'HEAD' : 'tip'} not in the merged PR`;
}

const PLAIN_PATH = /^[\w./\\@+=:,-]+$/;
// Worktree facts for every non-temp removal target of a command, checked in parallel: { [target]: { safe, why } }.
export async function worktreeFacts(command, env, rules, run) {
  const targets = [...new Set(localTargets(command, rules, env))].filter((t) => !isTempPath(t, env) && PLAIN_PATH.test(t));
  const facts = await Promise.all(targets.map((t) => worktreeFact(t, run)));
  return Object.fromEntries(targets.map((t, i) => [t, facts[i]]).filter(([, f]) => f));
}

// Facts for one branch a `git branch -D` deletes, in the repo at `dir`: safe when every commit on it is on a remote
// ref, or its tip is in the head of a merged PR of that name (squash merge, remote branch deleted).
export async function branchFact(dir, name, run) {
  if (!/^[\w./@+-]+$/.test(name) || name.startsWith('-')) return { safe: false, why: 'branch name not plain' };
  const sh = (argv, cwd) => Promise.resolve().then(() => run(argv, cwd)).catch(() => null);
  const git = (...args) => sh(['git', '-C', dir || '.', ...args]);
  const ahead = await git('rev-list', '--count', name, '--not', '--remotes');
  if (ahead == null || !/^\d+\s*$/.test(ahead)) return { safe: false, why: 'git check failed' };
  const n = Number(ahead);
  if (!n) return { safe: true, why: '' };
  const top = (await git('rev-parse', '--show-toplevel'))?.trim();
  const merged = top ? await mergedPrHead(git, sh, top, name, name) : 'git check failed';
  return merged === true ? { safe: true, why: '' } : { safe: false, why: `${unpushed(n)} (${merged})` };
}
const branchKey = ({ dir, name }) => `${dir}|${name}`;

// Branch facts for every `git branch -D` of a command, in parallel: { [dir|name]: { safe, why } }.
export async function branchFacts(command, rules, run, env = {}) {
  const targets = [...new Map(branchTargets(command, rules, env).map((b) => [branchKey(b), b])).values()].filter((b) => b.name !== NO_TARGET && PLAIN_PATH.test(b.dir || '.'));
  const facts = await Promise.all(targets.map((b) => branchFact(b.dir, b.name, run)));
  return Object.fromEntries(targets.map((b, i) => [branchKey(b), facts[i]]));
}

// Build output and caches a tool regenerates. A delete of one passes when git ignores it (`git check-ignore`, so it
// is inside a repo and untracked): nothing there is lost that a build or install cannot make again. `results` only
// under `evals/` (`claude plugin eval` output). No glob, no secret-looking segment, ever.
const REGENERABLE = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.terraform', 'dist', 'build', '.next', 'target', 'coverage', '.turbo', '.cache', '.wrangler', '.vitest-cache', '.vite', '.gradle', '.parcel-cache', '.svelte-kit', '.nuxt']);
const NEVER_REGEN = /^\.env|secret|\.key$/i;
export function regenerableName(target) {
  const segs = target.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const last = segs.at(-1);
  if (!PLAIN_PATH.test(target) || segs.some((s) => NEVER_REGEN.test(s))) return false;
  return REGENERABLE.has(last) || (last === 'results' && segs.at(-2) === 'evals');
}

// { [target]: true } for every removal target that is a regenerable name git ignores.
export async function regenFacts(command, env, rules, run) {
  const targets = [...new Set(localTargets(command, rules, env))].filter((t) => !isTempPath(t, env) && regenerableName(t));
  const ignored = await Promise.all(
    targets.map((t) => {
      const p = t.replace(/\\/g, '/').replace(/\/+$/, '');
      const i = p.lastIndexOf('/');
      const argv = ['git', '-C', i < 0 ? '.' : p.slice(0, i) || '/', 'check-ignore', '-q', '--', p.slice(i + 1)];
      return Promise.resolve().then(() => run(argv)).then((out) => out != null, () => false);
    }),
  );
  return Object.fromEntries(targets.filter((t, i) => ignored[i]).map((t) => [t, true]));
}

// A removal is exempt when it has targets and every one is a temp path, a safe worktree or regenerable output.
// A remote target (ssh, a container) passes only as a temp path: no fact about this machine applies to it.
function safeRemoval(command, rules, env, worktrees, regenerable) {
  const entries = removalEntries(command, rules, env);
  return entries.length > 0 && entries.every(({ target: t, remote }) => isTempPath(t, env) || (!remote && (worktrees[t]?.safe === true || regenerable[t] === true)));
}

// The pipeline a risky rule fires on, at whatever level of the command it sits: { raw, depth, siblings, host, top }.
// The whole command when no single pipeline matches (an opaque payload).
function riskyStep(command, rule) {
  const all = pipelines(command, { injected: !rule.skipInjected });
  const hit = all.find((p) => (rule.pipeline ? pipelineHit(rule, p) : riskyRe(rule).test(p.code) && (!rule.raw || new RegExp(rule.raw, 'i').test(p.raw))));
  return hit ?? { raw: command.trim(), depth: 0, siblings: all[0]?.top ?? 1, host: undefined, top: all[0]?.top ?? 1 };
}

// What the risky part does, in plain words, with the targets the guard resolved.
const shown = (t) => (t.startsWith(`${REMOTE_DIR}/`) ? t.slice(REMOTE_DIR.length + 1) : t.startsWith(`${UNKNOWN_DIR}/`) ? `${t.slice(UNKNOWN_DIR.length + 1)} (after a cd the guard cannot follow)` : t === NO_TARGET ? 'paths it cannot read (from a pipe or xargs)' : t);
function summary(command, rule, step, rules, env) {
  const list = (xs) => [...new Set(xs)].join(', ');
  if (REMOVAL.has(rule.id)) {
    const targets = removalTargets(command, rules, env);
    if (rule.id === 'worktree-rm') return `Force-removes worktree${targets.length > 1 ? 's' : ''} ${list(targets.map(shown))}`;
    return `Deletes${targets.length > 1 ? ` ${targets.length} paths` : ''} recursively: ${list(targets.map(shown))}`;
  }
  if (rule.id === 'branch-delete') {
    const names = branchTargets(command, rules, env).map((b) => (b.dir ? `${b.name} (in ${b.dir})` : b.name));
    return `Deletes branch${names.length > 1 ? 'es' : ''} ${list(names.length ? names : ['(unread)'])}`;
  }
  if (rule.id === 'force') {
    const args = plainArgs(/\bpush\b(.*)$/.exec(gitPlain(step.raw))?.[1] ?? '');
    return `Force-pushes${args.length ? ` ${args.join(' ')}` : ' the current branch'}`;
  }
  return rule.say ?? rule.why[0].toUpperCase() + rule.why.slice(1);
}

// A branch delete is exempt when every branch it names is safe (merged or pushed).
function safeBranchDelete(command, rules, branches, env) {
  const targets = branchTargets(command, rules, env);
  return targets.length > 0 && targets.every((b) => branches[branchKey(b)]?.safe === true);
}

// Shell writes to a file the agent could make with its edit tool, which the post-edit lint and the docs and skill hints
// never see: `sed -i`, `perl -pi`, inline Python or Node that writes a file, and `echo`, `printf`, `cat` (a heredoc
// too), `tee` or PowerShell's Set-Content, Add-Content, Out-File into a file. A write to /dev/*, an fd, `$null` or a
// temp path is not an edit.
const IN_PLACE = /(?:^|[\s;&|(])(?:sed\s(?:[^;&|\n]*\s)?(?:-[Enrsuz]*[iI]|--in-place)|perl\s(?:[^;&|\n]*\s)?-[0-9aelnpsw]*i)/;
const PY_INLINE = /(?:^|[\s;&|(/])python[\d.]*(?:\s+-\w+)*\s+(?:-c\b|-?\s*<<)/;
const PY_WRITE = /\bopen\(((?:[^()]|\([^()]*\))*?),\s*(?:mode\s*=\s*)?['"][rbtU]*[wax+]|\bPath\(((?:[^()]|\([^()]*\))*?)\)\s*\.\s*(?:write_text|write_bytes|open\(\s*['"][rbtU]*[wax+])/g;
const NODE_INLINE = /(?:^|[\s;&|(/])(?:(?:node|bun)(?:\s+-[\w-]+)*\s+(?:-e\b|--eval\b|-p\b|--print\b|-?\s*<<)|deno\s+eval\b)/;
const NODE_WRITE = /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream)\(\s*((?:[^(),]|\([^()]*\))+?)\s*[,)]/g;
const WRITERS = /^(?:echo|printf|cat|write-output)$/i;
const PS_WRITERS = /^(?:set-content|add-content|out-file)$/i;
const NOT_A_FILE = /^(?:\/dev\/\w+|\$null|nul)$/i;
const IN_PLACE_CMD = /^(?:sudo\s+)?(sed|perl)\b(.*)$/;
// The files an in-place `sed -i`/`perl -pi` edits: its operands without the script (the first operand, unless the
// script came with -e/-f). An empty list means "unread", which counts as an edit.
function inPlaceFiles(tool, rest) {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const operands = [];
  let script = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^-(?:e|f|-expression|-file)$/.test(w) || (tool === 'perl' && /^-[\w]*e$/.test(w))) (script = true), i++;
    else if (!w.startsWith('-') && w !== '""') operands.push(w);
  }
  return script ? operands : operands.slice(1);
}
export function shellEdit(command, env = {}) {
  const code = executable(command);
  const fileTarget = (t) => !NOT_A_FILE.test(t) && !isTempPath(t, env);
  for (const [inline, write] of [[PY_INLINE, PY_WRITE], [NODE_INLINE, NODE_WRITE]]) {
    if (!inline.test(code)) continue;
    for (const m of command.matchAll(write)) {
      const lit = /^\s*(['"`])([^'"`$]*)\1\s*$/.exec(m[1] ?? m[2]);
      if (!lit || fileTarget(expandPath(lit[2], {}, env))) return true;
    }
  }
  // Every write target in the directory and with the variables of its own command (`cd /tmp/x && cat > f`).
  for (const { code: c, dir, remote, resolve } of segments(command, env)) {
    if (remote) continue;
    const at = (t) => inDir(dir, resolve(t));
    const seg = c.replace(/\d*[<>]&\d+/g, ' ').replace(/&>/g, '>').replace(/<<-?\S*/g, ' ').trim();
    const inPlace = IN_PLACE.test(` ${seg}`) && IN_PLACE_CMD.exec(seg);
    if (inPlace) {
      const files = inPlaceFiles(inPlace[1], inPlace[2]);
      if (!files.length || files.map(at).some(fileTarget)) return true;
      continue;
    }
    const words = seg.split(/\s+/).filter((w) => !/^\w+=/.test(w));
    const cmd = words[0] === 'sudo' ? words[1] : words[0];
    if (!cmd) continue;
    let targets = [];
    if (WRITERS.test(cmd)) targets = [...seg.matchAll(/(?:^|\s)1?>>?\|?\s*([^\s;&|<>]+)/g)].map((m) => m[1]);
    else if (/^tee$/i.test(cmd)) targets = plainArgs(seg.replace(/^.*?\btee\b/i, ''));
    else if (PS_WRITERS.test(cmd)) {
      const rest = seg.replace(new RegExp(`^.*?\\b${cmd}\\b`, 'i'), '');
      const named = /\s-(?:file)?path\s+(\S+)|\s-literalpath\s+(\S+)/i.exec(rest);
      targets = named ? [named[1] ?? named[2]] : plainArgs(rest).slice(0, 1);
    }
    if (targets.map(at).some(fileTarget)) return true;
  }
  return false;
}

// `python`: the Python manager of the repo in cwd ('uv', 'poetry', 'pipenv', 'pip'; null for none), for deny rules with `when`.
// A whole command that only prints files (`cat f`, `head -n 5 f`, `sed -n 1,20p f`): the harness's read tool does it better.
const SHELL_READ = /^\s*(?:(?:cat|head|tail|less|more)(?:\s+-[\w-]+(?:\s+\d+)?)*|sed\s+-n\s+\S+)(?:\s+[^\s|;&<>()`$]+)+\s*$/;
const hint = (rule) => `Skill hint (${rule.why}): load ${rule.skills.map((s) => `\`${s}\``).join(' or ')} if this task is that work.`;

// `readTool`: the harness has a file-read tool (all but Codex), so a shell read gets a once-per-session hint.
// `worktrees`, `branches`, `regenerable`: facts the adapters gather (worktreeFacts, branchFacts, regenFacts).
export function evaluateCommand({ command, loadedSkills = new Set(), state, host = {}, env = {}, worktrees = {}, branches = {}, regenerable = {}, python = null, readTool = false, rules }) {
  // Hard denies come first and fire every time, like the title guard. A `when` rule denies only in a repo
  // that adopted that manager; elsewhere it lets the command through with a once-per-session note.
  const denied = deniedBy(command, rules)
  if (denied && (!denied.when || denied.when === python)) return { action: 'deny', rule: denied.id, reason: denied.why }
  const note = denied && !state.reminded.has(denied.id) ? denied.id : null

  const exempt = new Set([...(safeRemoval(command, rules, env, worktrees, regenerable) ? REMOVAL : []), ...(safeBranchDelete(command, rules, branches, env) ? ['branch-delete'] : [])]);
  const risky = rules.risky.find((r) => riskyMatch(r, command) && !exempt.has(r.id));
  if (risky) {
    const why = [
      ...Object.entries(worktrees).filter(([, f]) => !f.safe).map(([t, f]) => `\nWorktree ${t}: ${f.why}`),
      ...Object.entries(branches).filter(([, f]) => !f.safe).map(([k, f]) => `\nBranch ${k.slice(k.indexOf('|') + 1)}: ${f.why}`),
    ].join('');
    const step = riskyStep(command, risky);
    const what = summary(command, risky, step, rules, env);
    const where = step.host ? ` on ${step.host}` : '';
    const shown = step.raw !== command.trim() ? `\nStep: ${step.raw}` : '';
    const rule = `\nRule: ${risky.id} (${risky.why})`;
    // A risky step buried in a long chain, or in a shell -c, eval or ssh payload next to other commands, is hard to
    // read at the prompt: the agent runs it on its own instead (owner decision D15).
    if (step.top > 3 || (step.depth > 0 && step.siblings >= 3)) {
      return {
        action: 'deny',
        rule: risky.id,
        split: true,
        reason: `Risky step buried in a longer command: ${what}${where}.${shown}${rule}${why}\nRun the risky step as its own simple command, not inside bash -c, eval or ssh next to other commands or in a chain of more than 3, so the user can read what they approve. Then retry.`,
      };
    }
    return { action: 'ask', rule: risky.id, command, reason: `Risky command: ${what}${where}.${shown}${rule}${why}` };
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

  const heavy = hit(rules.heavy, command, { remote: false });
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
    if (rule.remind) return { action: 'allow', rule: rule.id, remind: true, context: hint(rule) };
    return {
      action: 'deny',
      rule: rule.id,
      reason:
        `AGENTS.md requires a skill here (${rule.why}). Load ${rule.skills.map((s) => `\`${s}\``).join(' or ')} ` +
        'first, then retry the same command.',
    };
  }
  if (!note && readTool && !state.reminded.has('read') && SHELL_READ.test(command)) {
    state.reminded.add('read');
    return { action: 'allow', rule: 'read', remind: true, context: 'Read files with the harness\'s read tool, not cat/head/tail/sed: it shows line numbers, pages large files and a wrong path is a plain error, not a failed shell command.' };
  }
  if (!note && !state.reminded.has('edit') && shellEdit(command, env)) {
    state.reminded.add('edit');
    return { action: 'allow', rule: 'edit', remind: true, context: 'Edit files with the harness\'s edit tool, not sed -i, perl -pi, inline Python or shell redirects: the post-edit lint and the docs and skill hints run only on edit tools.' };
  }
  if (!note) return { action: 'allow' };
  state.reminded.add(note);
  const uses = python ? `This repo uses ${python}` : 'This directory has no uv project';
  return { action: 'allow', rule: note, context: `${uses}, so \`${note}\` is allowed here; uv is preferred where the repo adopts it.` };
}

// An edit (any harness's edit or write tool) to a path a `files` rule watches: a once-per-session skill hint.
export function evaluateEdit({ path, loadedSkills = new Set(), state, rules }) {
  const p = String(path ?? '').replace(/\\/g, '/');
  const rule = (rules.files ?? []).find((r) => new RegExp(r.match, 'i').test(p));
  const loaded = new Set([...loadedSkills].map(bare));
  if (!rule || rule.skills.some((s) => loaded.has(s)) || state.reminded.has(rule.id)) return { action: 'allow' };
  state.reminded.add(rule.id);
  return { action: 'allow', rule: rule.id, remind: true, context: hint(rule) };
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
  return rules.heavy.some((r) => new RegExp(r.match, 'i').test(matchable(command, { remote: false })));
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

export function previewCommand(ruleId, command, rules, env = {}) {
  // `git -C DIR` previews DIR; a DIR with shell syntax gets no preview.
  const dirs = gitDirs(command);
  if (['reset', 'force'].includes(ruleId) && !dirs.every((d) => SAFE_TOKEN.test(d))) return null;
  const git = ['git', ...dirs.flatMap((d) => ['-C', d])];
  if (ruleId === 'reset') return [...git, 'status', '--short'];
  if (ruleId === 'force') return [...git, 'log', '--oneline', '-n', '10', 'HEAD..@{u}'];
  if (ruleId === 'rm' && rules) {
    // The delete's own targets, resolved through cd, ~ and variables; this machine's only.
    const entries = removalEntries(command, rules, env).filter((e) => !e.remote);
    const paths = entries.map((e) => e.target);
    if (!paths.length || !paths.every((p) => SAFE_TOKEN.test(p) && !p.startsWith('~'))) return null;
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
