// Shared rule engine for the Claude Code mod and the Copilot adapters.
// Pure functions: adapters gather facts (command, loaded skills, host, usage) and
// apply the decision. `state.reminded` (a Set) is mutated: each rule fires once
// per session ("remind once, then let it through").

import { analyze, commandWords, scan, units, WRAPPERS } from './shell.mjs';

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
      const parts = p.map((c) => ({ code: gitPlain(c.code.trim()), vals: commandWords(c.words).map((w) => w.val) }));
      out.push({ code: parts.map((x) => x.code).join(' | '), raw: p.map((c) => c.raw).join(' | '), parts, depth: ctx.depth, siblings: count(level), host: ctx.host, top });
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
// A `pipeline` rule fires on one pipeline whose code matches, whose text matches `raw` and not `unless`. A `help` rule
// leaves out a secret CLI that only prints its usage (`bws secret get --help`, `op help`, `gh auth token -h`): the help
// flag last and not after an option (where it could be that option's value), or a `help` subcommand. A file reader is never left out: BSD `cat .env --help`
// prints the file.
const HELP_CLI = /^(?:bws?|op|pass|security|chezmoi|gcloud|az|gh|printenv)$/;
const helpOnly = ({ vals }) => HELP_CLI.test(vals[0]?.replace(/^.*[\\/]/, '') ?? '') && ((/^(?:--help|-h)$/.test(vals.at(-1)) && !vals.at(-2).startsWith('-')) || vals[1] === 'help');
const pipelineCode = (r, p) => (r.help ? p.parts.filter((x) => !helpOnly(x)).map((x) => x.code).join(' | ') : p.code);
const pipelineHit = (r, p) => riskyRe(r).test(pipelineCode(r, p)) && (!r.raw || new RegExp(r.raw, 'i').test(p.raw)) && !(r.unless && new RegExp(r.unless, 'i').test(p.raw));

// Commands that set a commit or PR/MR title: [command words, title flags, flags that read the message from a file].
// az's -t is --target-branch, so az has --title only.
const TITLED = [
  [['git', 'commit'], /^(?:-[a-zA-Z]*m|--message)$/, /^(?:-[a-zA-Z]*F|--file)$/],
  [['gh', 'pr', /^(?:create|edit)$/], /^(?:--title|-t)$/],
  [['glab', 'mr', /^(?:create|update)$/], /^(?:--title|-t)$/],
  [['az', 'repos', 'pr', /^(?:create|update)$/], /^--title$/],
];
// git's global options before the subcommand (`git -C dir`, `-c k=v`, `--no-pager`): the ones that take a value.
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']);

// The message a word passes, or null when it cannot be read statically: a variable, a substitution other than
// `"$(cat <<'EOF' … EOF)"`, or a backtick. Single-quoted text is literal.
function literal(word) {
  const sub = /^"\$\(([\s\S]*)\)"$/.exec(word.raw);
  if (sub && word.substs.length === 1) {
    const [cat, ...rest] = scan(sub[1]);
    return !rest.length && commandWords(cat?.words ?? [])[0]?.val === 'cat' && cat.heredocs.length === 1 ? cat.heredocs[0] : null;
  }
  return /[$`]/.test(word.raw.replace(/'[^']*'/g, '')) ? null : word.val;
}

// The title one simple command sets, or null: the first title flag's value (`-m "x"`, `-mx`, `--title=x`), or the
// first line of a heredoc passed as `-F -` / `--file=-`. Only a command at command position counts, so
// `echo git commit -m x` sets none; a message read from a file or stdin without a heredoc is not read.
function titleIn(cmd) {
  let words = commandWords(cmd.words);
  if (words[0]?.val === 'git') {
    let k = 1;
    while (words[k]?.val.startsWith('-')) k += GIT_VALUE.has(words[k].val) ? 2 : 1;
    words = [words[0], ...words.slice(k)];
  }
  const vals = words.map((w) => w.val);
  const titled = TITLED.find(([name]) => name.every((n, i) => (typeof n === 'string' ? vals[i] === n : n.test(vals[i] ?? ''))));
  if (!titled) return null;
  const [name, flag, file] = titled;
  for (let i = name.length; i < words.length; i++) {
    const v = vals[i];
    if (v === '--') break;
    const eq = /^(--[\w-]+)=([\s\S]*)$/.exec(v);
    const joined = !v.startsWith('--') && /^(-[a-zA-Z]*?[mF])(.+)$/.exec(v);
    const [f, value] = eq ? [eq[1], { ...words[i], val: eq[2], raw: words[i].raw.slice(words[i].raw.indexOf('=') + 1) }] : joined && !flag.test(v) && !file?.test(v) ? [joined[1], { ...words[i], val: joined[2], raw: words[i].raw.slice(joined[1].length) }] : [v, words[i + 1]];
    if (file?.test(f)) return value?.val === '-' && cmd.heredocs.length ? cmd.heredocs[0] : null;
    if (flag.test(f)) return value ? literal(value) : null;
  }
  return null;
}

// Every title a command sets, in order: each simple command at command position, payloads (bash -c, ssh) included.
export function titlesOf(command) {
  return units(analysis(command))
    .map((u) => titleIn(u.cmd))
    .filter((t) => t !== null)
    .map((t) => t.split('\n')[0]);
}

// The first title that does not match the org's PR-title check (giocaizzi/.github `pr-title.yml`), or null. Git's own
// merge commit subjects ("Merge branch …") are skipped.
export function badTitle(command, rules) {
  const re = new RegExp(`^(${rules.titles.types.join('|')})(\\([a-z0-9._/-]+\\))?!?: [a-z].*$`);
  return titlesOf(command).find((t) => !re.test(t) && !/^Merge (?:branch|pull request|remote-tracking branch|tag|commit) /.test(t)) ?? null;
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
// followed only through plain `;`/`&&` chains with a plain DIR, up to the first subshell, group, `||` or conditional:
// a `cd` at or after one, or a `pushd`, makes the directory UNKNOWN_DIR, which no check accepts, and so does the first
// of them once a `cd` was followed (the `cd` may not have run). What runs before it keeps its directory, so a
// `(make test)` at the end of a cleanup chain no longer hides where an earlier delete ran.
// Paths are resolved the way the shell would, by position (owner decision D5): a leading `~` or `$HOME` from the
// environment, `$PWD` from the directory a followed `cd` reached (an absolute one only), and `$NAME` from an
// assignment earlier in the same command (`NAME=/abs/path`, `NAME=$(mktemp -d)`, `export NAME=…`), the latest one
// winning. A prefix assignment (`NAME=v cmd`) holds for that command only, so it is never followed. An unset or
// external variable, `~user` or a value that is not a plain path stays as written and asks.
// A double-quoted word with no spaces or other expansions ("$TMPDIR/x", "$S") is that word: unquote it so the
// temp check can resolve it instead of seeing the blanked string.
const SIMPLE_QUOTED = /"((?:\$\{?\w+\}?)?[^"\s$`\\]*)"/g;
const UNKNOWN_DIR = '<cd?>';
const REMOTE_DIR = '<remote>';
const NO_TARGET = '<none>';
const CD = /(?:^|[\s({])(?:cd|chdir|set-location|sl|pushd|popd|push-location|pop-location)(?=\s|$)/i;
const PLAIN_CD = /^\s*(?:cd|chdir|set-location|sl)(?:\s+(\S+))?\s*$/i;
const PLAIN_DIR = /^[\w.@%+=:,\\/~][\w.@%+=:,\\/~-]*$/;
// Where `cd` stops being followed: a separator that opens a subshell or a branch, or a group or keyword that starts one.
const BRANCH_SEP = new Set(['(', ')', '||', ';;']);
const BRANCH_CODE = /^\s*[{}]|(?:^|[\s;&|])(?:if|then|else|elif|fi|case|esac|for|while|until|select|do|done)(?=[\s;]|$)/i;
// A `cd` piped or sent to the background runs in a subshell and changes nothing after it.
const SUBSHELL_SEP = new Set(['|', '|&', '&']);
const ABSOLUTE = /^(?:[\\/]|[a-z]:|~|\$|%)/i;
const inDir = (dir, p) => (!dir || ABSOLUTE.test(p) ? p : `${dir}/${p}`);
const MKTEMP = /^\$\(mktemp(\s+-[dqu]+)*(\s+(-t|--tmpdir(=\S+)?)(\s+[\w.-]+)?)?\)$/;
const DECLARE = /^(?:export|declare|typeset|local|readonly)$/;
// Words before an assignment that still make it one: `export A=1`, `env A=1 cmd`.
const DECLARE_WORDS = /^(?:export|declare|typeset|local|readonly|env)$/;
const VAR_REF = /^\$(?:\{(\w+)\}|(\w+))(?=[\\/]|$)/;
// `word` with a leading `~`, `$HOME`, `$PWD` or `$NAME` resolved from `vars` (assignments so far), `env` and `pwd`
// (the absolute directory a followed `cd` reached); else as written.
function expandPath(word, vars, env, pwd) {
  if (/^~(?=[\\/]|$)/.test(word)) return env.HOME ? env.HOME.replace(/[\\/]+$/, '') + word.slice(1) : word;
  const m = VAR_REF.exec(word);
  if (!m) return word;
  const name = m[1] ?? m[2];
  const value = name in vars ? vars[name] : name === 'HOME' ? env.HOME?.replace(/[\\/]+$/, '') : name === 'PWD' ? pwd : undefined;
  return value ? value + word.slice(m[0].length) : word;
}
// A command made only of assignments (`A=1 B=2`, `export A=1`): they persist, so later commands see them.
function assign(cmd, vars, env, pwd) {
  const words = cmd.words.filter((w, i) => !(i === 0 && DECLARE.test(w.val)));
  if (!words.length || !words.every((w) => /^[A-Za-z_]\w*=/.test(w.val))) return false;
  for (const w of words) {
    const name = w.val.slice(0, w.val.indexOf('='));
    const raw = w.raw.slice(w.raw.indexOf('=') + 1).replace(/^"([\s\S]*)"$/, '$1');
    const value = expandPath(w.val.slice(name.length + 1), vars, env, pwd);
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
// Each entry: { seg (redirections dropped), code, words, redirs (output redirection targets), dir, remote, resolve(path) }.
// A `cd` holds past the end of its chain (`;`, a newline, `&`) only when it surely ran: nothing but assignments and
// other sure `cd`s ran before it in the whole command (`ran`, inherited by payloads), so nothing could have removed or
// moved its directory first, and that directory exists (`env.dirs`, which the adapter gathers through `cdDirs`). Else
// a failed `cd x; rm -rf y` (or `rm -rf x; cd x; rm -rf y`) would delete `./y`, so the directory becomes UNKNOWN_DIR
// after the break. Within a chain
// (`cd x && rm -rf y`) a failed `cd` stops what follows, so it always holds there.
// A payload whose text the outer shell expands first (`bash -c "…$X…"`, an ssh command, a heredoc: `p.expanded`)
// resolves `$NAME` and `$PWD` with the outer values (`frozen`), not with its own assignments and `cd`s; one that also
// escapes a `\$` for its own shell (`bash -c "D=x; rm -rf \$D"`) resolves neither, so its variables ask.
// `cds`, when given, collects every directory a `cd` reaches, each taken to exist (see cdDirs).
const CHAIN_BREAK = new Set([';', '\n', '&']);
const ABS_DIR = /^(?:\/|[a-z]:[\\/])/i;
function levelSegments(a, baseDir, remote, env, outer = {}, frozen = null, cds = null, ranBefore = false) {
  const vars = { ...outer };
  let ran = ranBefore;
  let dir = baseDir;
  let followCd = true;
  let sure = true;
  let chainSure = !ranBefore;
  const out = [];
  for (const [i, cmd] of a.commands.entries()) {
    const seg = cmd.code.replace(/\d*[<>]+(&\d+|\s*[^\s;&|]+)/g, ' ');
    if (i > 0 && CHAIN_BREAK.has(cmd.sep)) {
      if (dir !== baseDir && (!sure || cmd.sep === '&')) dir = UNKNOWN_DIR;
      chainSure = !ran;
    }
    // The first subshell, group, `||` or conditional: a later `cd` is not followed, nor an earlier one past it.
    if (followCd && (BRANCH_SEP.has(cmd.sep) || BRANCH_CODE.test(cmd.code))) {
      followCd = false;
      if (dir !== baseDir) dir = UNKNOWN_DIR;
    }
    const pwd = frozen ? frozen.pwd : ABS_DIR.test(dir) && PLAIN_PATH.test(dir) ? dir : undefined;
    const snapshot = frozen ? frozen.vars : { ...vars };
    const resolve = (p) => expandPath(p, snapshot, env, pwd);
    const ranHere = ran;
    if (assign(cmd, vars, env, pwd)) {
      // nothing runs
    } else if (CD.test(seg)) {
      const m = followCd && !SUBSHELL_SEP.has(cmd.sep) && !SUBSHELL_SEP.has(a.commands[i + 1]?.sep) && PLAIN_CD.exec(seg);
      const to = m && (m[1] === undefined ? env.HOME : resolve(m[1]));
      dir = to && PLAIN_DIR.test(to) && !/^~/.test(to) ? inDir(dir, to) : UNKNOWN_DIR;
      if (cds && dir !== UNKNOWN_DIR) cds.push(dir);
      sure = chainSure = chainSure && dir !== UNKNOWN_DIR && (cds !== null || env.dirs?.has(dir) === true);
      // bash resets $PWD and $OLDPWD on every cd.
      delete vars.PWD;
      delete vars.OLDPWD;
    } else {
      chainSure = false;
      ran = true;
      if (!cmd.payloads.some((p) => p.remote && p.kind !== 'subst')) out.push({ seg: gitPlain(seg), code: cmd.code, words: cmd.words, redirs: cmd.redirs, dir: gitDirs(seg).map(resolve).reduce(inDir, dir), remote, resolve });
    }
    for (const p of cmd.payloads) {
      const inner = p.expanded === 'escaped' ? { vars: {}, pwd: undefined } : p.expanded ? { vars: snapshot, pwd } : frozen;
      out.push(...(p.remote ? levelSegments(p.analysis, REMOTE_DIR, true, {}, {}, inner) : levelSegments(p.analysis, dir, remote, env, snapshot, inner, cds, ranHere)));
    }
  }
  return out;
}
const prepared = (command) => analysis(expandLoops(command).replace(SIMPLE_QUOTED, '$1'));
function segments(command, env = {}) {
  return levelSegments(prepared(command), '', false, env);
}
// Every directory a `cd` in the command reaches on this machine, as the engine names it (relative to the cwd when it
// does not start with `/`): the adapter checks which exist and passes them back as `env.dirs`.
export function cdDirs(command, env = {}) {
  const cds = [];
  levelSegments(prepared(command), '', false, env, {}, null, cds);
  return [...new Set(cds)];
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

// Branches every `git branch -D` in a command deletes: { dir, name }, `dir` from `cd`/`git -C` ('' for the cwd). One
// on another host or in a container has dir REMOTE_DIR: no fact is gathered for it, so it never rides on a safe one.
export function branchTargets(command, rules, env = {}) {
  const re = riskyRe(rules.risky.find((r) => r.id === 'branch-delete'));
  return segments(command, env)
    .filter(({ seg }) => re.test(seg))
    .flatMap(({ seg, dir, remote }) => {
      const names = plainArgs(/\bbranch\b(.*)$/.exec(seg)?.[1] ?? '');
      return (names.length ? names : [NO_TARGET]).map((name) => ({ dir: remote ? REMOTE_DIR : dir, name }));
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

// Tags a `git tag -f <name> [<commit>]` or `git tag -d <name>…` moves or deletes: { dir, name }. Any other release step
// (creating a tag, an annotated or signed one, a tag named like a version, release-please, npm version, another
// host's) has no name, so it never rides on a local one.
const VERSION_TAG = /^v?\d+(?:\.\d+)+/i;
export function tagTargets(command, rules, env = {}) {
  const re = new RegExp(rules.skills.find((r) => r.id === 'release').match, 'i');
  return segments(command, env)
    .filter(({ seg }) => re.test(seg))
    .flatMap(({ words, dir, remote }) => {
      let vals = commandWords(words).map((w) => w.val);
      if (vals[0] === 'git') {
        let k = 1;
        while (vals[k]?.startsWith('-')) k += GIT_VALUE.has(vals[k]) ? 2 : 1;
        vals = vals.slice(k);
      }
      const opts = vals.slice(1).filter((v) => v.startsWith('-'));
      const names = vals.slice(1).filter((v) => !v.startsWith('-'));
      const del = opts.length > 0 && opts.every((o) => /^(?:-d|--delete)$/.test(o));
      const force = opts.length > 0 && opts.every((o) => /^(?:-f|--force)$/.test(o));
      const named = del ? names : force ? names.slice(0, 1) : [];
      const ok = vals[0] === 'tag' && !remote && named.length > 0 && named.every((n) => /^[\w./@+-]+$/.test(n) && !VERSION_TAG.test(n));
      return ok ? named.map((name) => ({ dir, name })) : [{ dir, name: NO_TARGET }];
    });
}
// A tag no remote has: `git remote` lists none, or `git ls-remote --tags <remote> refs/tags/<name>` is empty on each.
// A failed lookup (offline, auth) counts as on a remote.
export async function tagFact(dir, name, run) {
  const sh = (argv) => Promise.resolve().then(() => run(argv)).catch(() => null);
  const remotes = await sh(['git', '-C', dir || '.', 'remote']);
  if (remotes == null) return { local: false, why: 'git check failed' };
  const found = await Promise.all(remotes.split(/\r?\n/).filter(Boolean).map((r) => sh(['git', '-C', dir || '.', 'ls-remote', '--tags', r, `refs/tags/${name}`])));
  if (found.some((f) => f == null)) return { local: false, why: 'ls-remote failed' };
  return found.every((f) => !f.trim()) ? { local: true, why: '' } : { local: false, why: 'on a remote' };
}
// Tag facts for every tag a command moves or deletes: { [dir|name]: { local, why } }.
export async function tagFacts(command, rules, run, env = {}) {
  const targets = [...new Map(tagTargets(command, rules, env).map((t) => [branchKey(t), t])).values()].filter((t) => t.name !== NO_TARGET && PLAIN_PATH.test(t.dir || '.'));
  const facts = await Promise.all(targets.map((t) => tagFact(t.dir, t.name, run)));
  return Object.fromEntries(targets.map((t, i) => [branchKey(t), facts[i]]));
}
// Never with a push, a release or a `gh api` write in the same command: `git tag -f foo && git push origin foo`
// publishes it, and a ref write can sit in a quoted field or an `--input` file the text does not show (#208).
const GH_API_WRITE = /\bgh\s+api\b[^|;&]*(?:(?:-X|--method)\s*=?\s*(?:POST|PATCH|PUT|DELETE)\b|(?:^|\s)(?:-[fF]|--field|--raw-field|--input)(?:[\s=]|\S)|refs\/tags)/i;
const localTagsOnly = (command, rules, tags, env) => {
  const targets = tagTargets(command, rules, env);
  if (segments(command, env).some(({ seg }) => /\bgit\b[^|;&]*\bpush\b|\bgh\s+release\b/.test(seg) || GH_API_WRITE.test(seg.replace(/['"\\]/g, '')))) return false;
  return targets.length > 0 && targets.every((t) => tags[branchKey(t)]?.local === true);
};

// Branch refs every `gh api -X DELETE …/git/refs/heads/<b>` deletes: { dir, repo, name }, `repo` null for gh's
// `{owner}/{repo}` placeholder, which gh fills from the repo in `dir`. The endpoint is gh's first operand, read from
// the words with every option's value skipped (a `--jq` or `--template` value naming a ref is not the endpoint). Any
// other GitHub delete (a repo, a tag, a release), another host's (`--hostname`, GH_HOST) or another repo's (GH_REPO
// set in the command) has no name, so it never rides on a safe ref.
const GH_API_VALUE = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '-q', '--jq', '-t', '--template', '--input', '-p', '--preview', '--cache', '--hostname']);
const REF_ENDPOINT = /^\/?repos\/([\w.-]+\/[\w.-]+|\{owner\}\/\{repo\})\/git\/refs\/heads\/(\S+)$/;
function refEndpoint(words) {
  const vals = commandWords(words).map((w) => w.val);
  if (vals[0] !== 'gh' || vals[1] !== 'api') return null;
  let endpoint = null;
  for (let k = 2; k < vals.length; k++) {
    const v = vals[k];
    if (v === '--') {
      endpoint ??= vals[k + 1] ?? null;
      break;
    }
    if (/^--hostname(?:=|$)/.test(v)) return null;
    if (GH_API_VALUE.has(v)) k++;
    else if (!v.startsWith('-')) endpoint ??= v;
  }
  return endpoint && REF_ENDPOINT.exec(endpoint);
}
// A variable a command sets anywhere (prefix, export, env, a plain assignment), at any level on this machine.
const setsVariable = (command, re) =>
  units(analysis(command)).some(({ cmd, remote }) => !remote && cmd.words.some((w, i, ws) => re.test(w.val) && ws.slice(0, i).every((x) => /^[A-Za-z_]\w*=/.test(x.val) || DECLARE_WORDS.test(x.val))));
export function refTargets(command, rules, env = {}) {
  const re = riskyRe(rules.risky.find((r) => r.id === 'gh-delete'));
  const elsewhere = setsVariable(command, /^GH_(?:REPO|HOST)=/);
  return segments(command, env)
    .filter(({ seg }) => re.test(seg))
    .map(({ words, dir, remote }) => {
      const m = !remote && !elsewhere && refEndpoint(words);
      return m ? { dir, repo: m[1].startsWith('{') ? null : m[1], name: m[2] } : { dir: remote ? REMOTE_DIR : dir, repo: null, name: NO_TARGET };
    });
}
const refKey = ({ dir, repo, name }) => `${dir}|${repo ?? ''}|${name}`;

// Facts for one branch ref a `gh api` DELETE removes on GitHub: safe when the ref's tip is the head of a merged PR of
// that branch, so the merge holds every commit the ref has. The default branch never is.
export async function refFact({ dir, repo, name }, run) {
  if (!/^[\w./@+-]+$/.test(name) || name.startsWith('-')) return { safe: false, why: 'branch name not plain' };
  if (/^(?:main|master)$/.test(name)) return { safe: false, why: 'the default branch' };
  const sh = (argv) => Promise.resolve().then(() => run(argv, dir || undefined)).catch(() => null);
  const [oid, tip] = await Promise.all([
    sh(['gh', 'pr', 'list', ...(repo ? ['-R', repo] : []), '--head', name, '--state', 'merged', '--json', 'headRefOid', '--limit', '1', '--jq', '.[0].headRefOid // empty']),
    sh(['gh', 'api', `repos/${repo ?? '{owner}/{repo}'}/git/ref/heads/${name}`, '--jq', '.object.sha']),
  ]);
  if (oid == null || tip == null) return { safe: false, why: 'gh check failed' };
  if (!oid.trim()) return { safe: false, why: 'no merged PR' };
  return oid.trim() === tip.trim() ? { safe: true, why: '' } : { safe: false, why: 'its tip is not the head of the merged PR' };
}

// Ref facts for every branch ref a command deletes through `gh api`, in parallel: { [dir|repo|name]: { safe, why } }.
export async function refFacts(command, rules, run, env = {}) {
  const targets = [...new Map(refTargets(command, rules, env).map((r) => [refKey(r), r])).values()].filter((r) => r.name !== NO_TARGET && PLAIN_PATH.test(r.dir || '.'));
  const facts = await Promise.all(targets.map((r) => refFact(r, run)));
  return Object.fromEntries(targets.map((r, i) => [refKey(r), facts[i]]));
}

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

// GUARD_UNATTENDED as a command sets it for this machine (`export GUARD_UNATTENDED=1`, a prefix
// `GUARD_UNATTENDED=1 cmd`, `env GUARD_UNATTENDED=1 cmd`): true when on (1, true, on), false for any other value or
// `unset GUARD_UNATTENDED`, null when the command does not set it. Only words in assignment position count, so a commit message or an echo
// naming it does not; another host's or a container's setting is not this session's.
export function unattendedSet(command) {
  let set = null;
  for (const { cmd, remote } of units(analysis(command))) {
    if (remote) continue;
    const words = cmd.words.map((w) => w.val);
    if (words[0] === 'unset' && words.includes('GUARD_UNATTENDED')) set = false;
    for (let k = DECLARE_WORDS.test(words[0] ?? '') ? 1 : 0; k < words.length && /^[A-Za-z_]\w*=/.test(words[k]); k++) {
      const m = /^GUARD_UNATTENDED=([\s\S]*)$/.exec(words[k]);
      if (m) set = /^(?:1|true|on)$/i.test(m[1]);
    }
  }
  return set;
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
    const names = branchTargets(command, rules, env).map((b) => (b.dir === REMOTE_DIR ? `${b.name} (on another host)` : b.dir ? `${b.name} (in ${b.dir})` : b.name));
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

// A GitHub delete is exempt when every one in the command is a branch ref whose tip a merged PR holds.
function safeRefDelete(command, rules, refs, env) {
  const targets = refTargets(command, rules, env);
  return targets.length > 0 && targets.every((r) => refs[refKey(r)]?.safe === true);
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

// A shell write, in a factory run, to a protected path (#213): `protect.globs` (`rules.factory.protectedPaths`, always,
// plus FACTORY_PROTECTED_PATHS), each over paths relative to the repo root (`protect.root`; the cwd when unknown). Writes are output redirections of any command, `tee`, `sed -i`/`perl -pi`, Set-Content, Add-Content,
// Out-File and Tee-Object, the operands of rm, Remove-Item and their aliases, the sources and destination of mv and
// Move-Item, and the destination of cp and Copy-Item (a destination also as `<dest>/<source name>`, a directory it may
// be). Removing or moving away a directory above a protected path counts (`rm -rf .github`, `rm -rf .`), along a
// glob's literal leading segments only (`**/*.tf` puts no directory above it). Letter case is ignored, as macOS and
// Windows do. A target the shell globs is matched as a glob (`.g*` may name `.github`; a leading `*` or `?` never names
// a dot file), a brace list is expanded (one group a level, 64 words at most), and one whose start is a variable or a
// `cd` not followed is matched by the rest of its path anywhere (`$ROOT/.github/x`). A command that may write fails
// closed past the limits (`rules.factory.protectedLimits`: targets, characters, milliseconds) or when the check throws,
// since a hook that times out or emits nothing lets the command through; globs past the limits are ignored. Returns { target } (the first protected target as written), { unsure } (a limit it hit) or null.
const PROTECT_RM = /^(?:rm|rmdir|unlink|remove-item|ri|del|erase|rd)$/;
const PROTECT_MV = /^(?:mv|move-item|mi|move)$/;
const PROTECT_CP = /^(?:cp|copy-item|ci|copy|cpi)$/;
const PROTECT_PS = /^(?:set-content|add-content|out-file|tee-object|sc|ac)$/;
const SEG_GLOB = /[*?[]/;
const posixPath = (p) => p.replace(/\\/g, '/');
function normalizeSegments(path) {
  const out = [];
  for (const s of path.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (!out.length || out.at(-1) === '..') out.push('..');
      else out.pop();
    } else out.push(s);
  }
  return out;
}
// The repo-relative segments of a target: { segs } from the root, { segs, suffix: true } when its start is unknown,
// or null outside the repo.
function repoSegments(target, dir, protect) {
  const p = posixPath(target);
  const cwdRel = protect.root && protect.cwd ? relativeTo(posixPath(protect.root), posixPath(protect.cwd)) : [];
  // A first segment that is only a variable or `~user` is dropped; one with text after the variable stays (`$P.github`).
  if (/^[$~%`]/.test(p)) {
    const segs = normalizeSegments(p);
    return { segs: /^(?:\$(?:\{[^}]*\}|\w+|\([^)]*\))|%\w+%|~[\w.-]*|`[^`]*`)$/.test(segs[0] ?? '') ? segs.slice(1) : segs, suffix: true };
  }
  // An absolute target is where it says, whatever directory a `cd` reached.
  if (dir === UNKNOWN_DIR && !ABS_DIR.test(p)) return { segs: normalizeSegments(p), suffix: true };
  const full = dir && !ABS_DIR.test(p) ? `${posixPath(dir).replace(/\/+$/, '')}/${p}` : p;
  if (ABS_DIR.test(full)) {
    if (!protect.root) return { segs: normalizeSegments(full), suffix: true };
    return relativeTo(posixPath(protect.root), full.replace(/^\/(?=[a-z]:)/i, ''), true);
  }
  const segs = normalizeSegments([...cwdRel, ...full.split('/')].join('/'));
  // Above the root (`..`) holds the whole repo; beside it (`../other`) is outside.
  if (segs[0] === '..') return segs.every((x) => x === '..') ? { segs: [] } : null;
  return { segs };
}
// `path` relative to `root` as segments (case ignored); with `wrap`, { segs }, `{ segs: [] }` for a directory above the
// root (it holds the whole repo), or null when outside.
function relativeTo(root, path, wrap = false) {
  const r = normalizeSegments(root);
  const s = normalizeSegments(path);
  const same = (a, b) => a.slice(0, Math.min(a.length, b.length)).every((x, i) => x.toLowerCase() === b[i].toLowerCase());
  const inside = r.length <= s.length && same(r, s);
  if (!wrap) return inside ? s.slice(r.length) : [];
  return inside ? { segs: s.slice(r.length) } : same(s, r) ? { segs: [] } : null;
}
// Whether two globs may name one word: the text before the first wildcard of each, and after the last, agree (`*.log`
// never meets `*.tf`).
function globsMayMeet(a, b) {
  const head = (g) => g.slice(0, g.search(/[*?[]/)).toLowerCase();
  const tail = (g) => g.slice(Math.max(g.lastIndexOf('*'), g.lastIndexOf('?'), g.lastIndexOf(']')) + 1).toLowerCase();
  const agree = (x, y, end) => (end ? x.endsWith(y) || y.endsWith(x) : x.startsWith(y) || y.startsWith(x));
  return agree(head(a), head(b), false) && agree(tail(a), tail(b), true);
}
// Whether one target segment may be one protected-pattern segment.
// A variable may hold a leading dot, so only a written `*`, `?` or `[` at the start keeps a dot file out.
function segMayMatch(pat, seg) {
  const glob = seg.replace(/\$(?:\{[^}]*\}|\w+|\([^)]*\))|%\w+%|`[^`]*`/g, '*');
  if (SEG_GLOB.test(glob)) {
    if (/^[*?[]/.test(seg) && pat.startsWith('.')) return false;
    return SEG_GLOB.test(pat) ? globsMayMeet(glob, pat) : globMatches(glob, pat.toLowerCase());
  }
  return SEG_GLOB.test(pat) ? globMatches(pat, glob.toLowerCase()) : pat.toLowerCase() === glob.toLowerCase();
}
// Whether pattern segments `pat` match target segments `segs`; `above` lets the target end above a match, when every
// segment it has matched one literal leading segment of the pattern (no `**` took any). `tick` counts the work.
function patternHits(pat, segs, above, suffix, tick) {
  const memo = new Map();
  const f = (i, j) => {
    const key = i * (segs.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    tick();
    let r;
    if (j === segs.length) r = (above && i === j && !pat.slice(0, i).includes('**')) || pat.slice(i).every((p) => p === '**');
    else if (i === pat.length) r = false;
    else if (pat[i] === '**') r = f(i + 1, j) || f(i, j + 1);
    else r = segMayMatch(pat[i], segs[j]) && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  if (!suffix) return f(0, 0);
  // An unknown start (a variable, a `cd` not followed, an absolute path with no known root): any tail of the path.
  return segs.some((_, j) => f(0, j));
}
// The words a brace list expands to, innermost list first, a range kept as a glob and a group that is no list left as
// written; null past `limit` words or with more than `limit` groups. Iterative: a word of thousands of groups must not
// overflow the stack.
function expandBraces(text, limit = 64) {
  if ((text.match(/\{/g) ?? []).length > limit) return null;
  const done = [];
  const todo = [text];
  while (todo.length) {
    const word = todo.pop();
    const m = [...word.matchAll(/\{([^{}]*)\}/g)].find((g) => /,|\.\./.test(g[1]));
    if (!m) {
      done.push(word);
      continue;
    }
    const head = word.slice(0, m.index);
    const tail = word.slice(m.index + m[0].length);
    for (const part of m[1].includes(',') ? m[1].split(',') : ['*']) todo.push(head + part + tail);
    if (done.length + todo.length > limit) return null;
  }
  return done;
}
const LIMITED = Symbol('limited');
// A command that may write at all: an output redirection or a writer's name. Only such a command can fail closed.
const MAY_WRITE = /[>]|(?:^|[^\w-])(?:tee|sed|perl|rm|rmdir|unlink|mv|cp|move|copy|set-content|add-content|out-file|tee-object|remove-item|move-item|copy-item|ri|mi|ci|cpi|del|erase|rd|sc|ac)(?![\w-])/i;
export function protectedWrite(command, protect, env = {}, limits = { globs: 256, targets: 512, chars: 1024, ms: 2000 }) {
  // A setting past the limits is cut, not failed: globs over `chars` are dropped, then all past `globs` (defaults first).
  const globs = protect.globs.filter((g) => g.length <= limits.chars).slice(0, limits.globs).map((g) => normalizeSegments(posixPath(g).replace(/\/$/, '/**')));
  const until = Date.now() + limits.ms;
  let work = 0;
  let targets = 0;
  const tick = () => {
    if ((++work & 255) === 0 && Date.now() > until) throw LIMITED;
  };
  // One write target as written: counted, and checked for length, once however many spellings it has.
  const count = (w) => {
    if (++targets > limits.targets || w.val.length > limits.chars) throw LIMITED;
  };
  const hits = (target, dir, resolve, above) => {
    const at = repoSegments(resolve(target), dir, protect);
    return at !== null && globs.some((g) => patternHits(g, at.segs, above, at.suffix, tick));
  };
  try {
    const target = scanWrites(command, env, count, hits);
    return target === null ? null : { target };
  } catch (e) {
    // Any failure (a limit, a stack overflow, a bug) denies a command that may write, and lets the rest through.
    if (!MAY_WRITE.test(command)) return null;
    return { unsure: e === LIMITED ? `more than ${limits.targets} write targets, one over ${limits.chars} characters, a brace list of more than 64 words, or over ${limits.ms} ms to check` : 'the check failed' };
  }
}
// PowerShell and cmd keep a backslash (`.github\ci.yml`) that a POSIX shell reads as an escape: both spellings count. A
// brace list the shell expands counts as each word it yields; past the limit, the command fails closed.
function spellings(w) {
  const out = [w.val, ...(w.raw.includes('\\') ? [w.raw.replace(/['"]/g, '')] : [])];
  if (!/\{/.test(w.val) || !dynamicText(w.raw)) return out;
  const words = expandBraces(w.val);
  if (!words) throw LIMITED;
  return [...out, ...words];
}
const POSIX_MOVERS = /^(?:cp|mv)$/;
function scanWrites(command, env, count, hits) {
  for (const { words, redirs = [], dir, remote, resolve } of segments(command, env)) {
    if (remote) continue;
    for (const w of redirs) {
      if (NOT_A_FILE.test(w.val)) continue;
      count(w);
      for (const t of spellings(w)) if (!NOT_A_FILE.test(t) && hits(t, dir, resolve, false)) return t;
    }
    // Past reserved words (`then rm …`, `{ cp …`, `! tee …`), as the hidden-gh check reads them.
    const cw = commandWords(dropReserved(words));
    if (!cw.length) continue;
    const name = cw[0].val.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    const inPlace = (name === 'sed' && cw.some((w) => /^(?:-[Enrsuz]*[iI]|--in-place)/.test(w.val))) || (name === 'perl' && cw.some((w) => /^-[0-9aelnpsw]*i/.test(w.val)));
    if (!(name === 'tee' || inPlace || PROTECT_PS.test(name) || PROTECT_RM.test(name) || PROTECT_MV.test(name) || PROTECT_CP.test(name))) continue;
    // Only a writer's words are counted and expanded: a read-only command never fails closed.
    for (const w of cw.slice(1)) if (!w.val.startsWith('-')) count(w);
    const args = cw.slice(1).flatMap(spellings);
    const operands = args.filter((a) => !a.startsWith('-'));
    let writes = [];
    let removes = [];
    if (name === 'tee') writes = operands;
    else if (inPlace) {
      const files = inPlaceFiles(name, args.join(' '));
      writes = files.length ? files : operands;
    } else if (PROTECT_PS.test(name)) {
      const k = args.findIndex((a) => /^-(?:path|filepath|literalpath)$/i.test(a));
      const end = args.findIndex((x, i) => i > k && x.startsWith('-'));
      writes = k >= 0 ? args.slice(k + 1, end < 0 ? undefined : end) : operands.slice(0, 2);
    } else if (PROTECT_RM.test(name)) removes = operands;
    else {
      let dest = null;
      const sources = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        // GNU: `--target-directory` or any prefix of it down to `--t`, glued with `=` or not; a short-flag cluster
        // ending in `t` (`-rt DIR`) or holding it with its value glued (`-tDIR`, `-rtDIR`).
        const long = /^(--[a-z-]+)(?:=(.*))?$/.exec(a);
        const short = POSIX_MOVERS.test(name) && /^-([A-Za-z]*?)t(.*)$/.exec(a);
        if (long && long[1].length >= 3 && '--target-directory'.startsWith(long[1])) dest = long[2] ?? args[++k] ?? null;
        else if (short && /^[a-su-zA-Z]*$/.test(short[1])) dest = short[2] || (args[++k] ?? null);
        else if (/^-destination$/i.test(a)) dest = args[++k] ?? null;
        else if (!a.startsWith('-')) sources.push(a);
      }
      if (dest === null) dest = sources.pop() ?? null;
      if (dest !== null) writes = [dest, ...sources.map((src) => `${dest}/${posixPath(src).replace(/\/+$/, '').split('/').pop()}`)];
      if (PROTECT_MV.test(name)) removes = sources;
    }
    for (const t of writes) if (hits(t, dir, resolve, false)) return t;
    for (const t of removes) if (hits(t, dir, resolve, true)) return t;
  }
  return null;
}

// `python`: the Python manager of the repo in cwd ('uv', 'poetry', 'pipenv', 'pip'; null for none), for deny rules with `when`.
// A whole command that only prints files (`cat f`, `head -n 5 f`, `sed -n 1,20p f`): the harness's read tool does it better.
const SHELL_READ = /^\s*(?:(?:cat|head|tail|less|more)(?:\s+-[\w-]+(?:\s+\d+)?)*|sed\s+-n\s+\S+)(?:\s+[^\s|;&<>()`$]+)+\s*$/;
// A command that only prints project files: `cat`, `head`, `tail`, `less`, `more` or `sed -n <range>p` of plain relative
// paths (no leading `/` or `~`, no `:` or `\` (a Windows drive, a PowerShell `env:`), no `..`, no empty or `.` segment), optionally after one `cd <dir> &&` of the same form.
// No quotes, variables, globs, redirections or pipes, no sed script but a line range, and no path that looks like a
// secret (`.env*`, keys, tokens, `.git/config`, Terraform state, ...). The guard allows these outright, so a harness
// prompt never stalls a read; anything outside the working tree goes through the harness's own permission flow.
const PLAIN_TOKEN = /^[\w./@%+=:,~-]+$/;
const SED_RANGE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;
const RELATIVE_PATH = (p) => !/^[/~]|[:\\]/.test(p) && p.split('/').every((x, i, all) => (x !== '' || i === all.length - 1) && x !== '.' && x !== '..');
const SECRET_PATH = /(?:^|\/)(?:\.git\/config|[^/]*\.tf(?:state|vars)(?:\.[\w.-]+)?|[^/]*\.env|auth\.json|[^/]*history|\.env(?:rc)?(?:\.[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|id_[\w-]+|[^/]*(?:secret|token|credential|passw|private)[^/]*|[^/]*\.(?:pem|key|p12|pfx|kdbx|keychain(?:-db)?|jks|asc|gpg)|kubeconfig|[^/]*\.kubeconfig)$|(?:^|\/)\.(?:ssh|gnupg|aws|azure|kube|docker|password-store|config\/gh|config\/gcloud)(?:\/|$)|^\/(?:dev|proc|sys)\//i;
export function pureRead(command) {
  const m = /^\s*(?:cd\s+(\S+)\s*&&\s*)?(\S+)((?:[ \t]+\S+)+)\s*$/.exec(command);
  if (!m || (m[1] && (!PLAIN_TOKEN.test(m[1]) || !RELATIVE_PATH(m[1]) || SECRET_PATH.test(m[1])))) return false;
  const [tool, words] = [m[2], m[3].trim().split(/\s+/)];
  if (!words.every((w) => PLAIN_TOKEN.test(w))) return false;
  let paths;
  if (tool === 'sed') {
    if (words[0] !== '-n' || !SED_RANGE.test(words[1] ?? '')) return false;
    paths = words.slice(2);
  } else if (/^(?:cat|head|tail|less|more)$/.test(tool)) {
    paths = words.filter((w, i) => !w.startsWith('-') && !(/^\d+$/.test(w) && /^-[nc]$/.test(words[i - 1] ?? '')));
  } else return false;
  // Judged joined to the `cd` dir, so `cd .config && cat gh/hosts.yml` is `.config/gh/hosts.yml`.
  return paths.length > 0 && paths.every((p) => !p.startsWith('-') && RELATIVE_PATH(p) && !SECRET_PATH.test((m[1] ? `${m[1].replace(/\/+$/, '')}/${p}` : p).replace(/\/+$/, '')));
}

const hint = (rule) => `Skill hint (${rule.why}): load ${rule.skills.map((s) => `\`${s}\``).join(' or ')} if this task is that work.`;

// One plain `gh` command, read without a shell tokenizer: its words, or null for anything else. Single-quoted spans are
// literal in POSIX shells, and so is a double-quoted one without `\`, `$` or a backtick, or `{name}`; each stays one word. Any
// shell syntax left after that (a separator, redirection, substitution, glob, escape, comment, leftover quote, newline)
// gives null, so a misread line is never taken for a plain command.
function plainGh(command) {
  if (command.includes('\0')) return null;
  const spans = [];
  const rest = command.replace(/'([^']*)'|"([^"\\$`]*)"/g, (_, s, d) => `\0${spans.push(s ?? d) - 1}\0`)
    // `{owner}`: braces around one name, no `,` or `..`, are literal (gh fills them in), unlike `{a,b}`.
    .replace(/\{[A-Za-z_]\w*\}/g, (b) => `\0${spans.push(b) - 1}\0`);
  if (/[;&|<>(){}$`\\#\n\r'"*?[\]]/.test(rest)) return null;
  const words = rest.trim().split(/[ \t]+/).map((w) => w.replace(/\0(\d+)\0/g, (_, i) => spans[i]));
  return words[0] === 'gh' ? words.slice(1) : null;
}

const API_LONG = { '--hostname': true, '--cache': true, '--header': true, '--input': true, '--jq': true, '--method': true, '--preview': true, '--raw-field': true, '--field': true, '--template': true, '--include': false, '--paginate': false, '--silent': false, '--slurp': false, '--verbose': false };
const API_SHORT = { X: '--method', H: '--header', f: '--raw-field', F: '--field', q: '--jq', t: '--template', p: '--preview' };

// What a plain `gh` command does: 'read' (`issue|pr view|list|status` without `--web`; `gh api` with GET and no field,
// `--input` or unknown flag), { write: <endpoint> } for another `gh api` call, else null.
function ghAction(args) {
  const positional = [];
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    if (['-R', '--repo', '--hostname'].includes(args[i])) i++;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  if (['issue', 'pr'].includes(positional[0]) && ['view', 'list', 'status'].includes(positional[1])) {
    return args.some((a) => /^--web(?:=|$)|^-[A-Za-z]*w/.test(a)) ? null : 'read';
  }
  if (positional[0] !== 'api') return null;
  let method = 'GET', endpoint = null, body = false;
  const take = (flag, value) => {
    if (flag === '--method') method = value.toUpperCase();
    else if (['--raw-field', '--field', '--input'].includes(flag)) body = true;
  };
  for (let i = args.indexOf('api') + 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [flag, glued] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
      if (!(flag in API_LONG)) return null;
      if (API_LONG[flag]) take(flag, glued ?? args[++i] ?? '');
    } else if (a.startsWith('-') && a.length > 1) {
      // pflag shorthand: `-i` is the one boolean; the first value flag takes the rest (`-XPOST`, `-f=k=v`) or the next word.
      const m = /^-i*([A-Za-z])=?(.*)$/.exec(a);
      if (!m || !(m[1] in API_SHORT)) { if (!/^-i+$/.test(a)) return null; continue; }
      take(API_SHORT[m[1]], m[2] !== '' || a.includes('=') ? m[2] : args[++i] ?? '');
    } else if (endpoint === null) endpoint = a;
    else return null;
  }
  return method === 'GET' && !body ? 'read' : { write: endpoint ?? '' };
}

// Subcommands that cannot send a body the guard cannot read to a labels or issues endpoint (`gh api` can).
const GH_SUBCOMMANDS = new Set(['issue', 'pr', 'repo', 'run', 'workflow', 'search', 'release', 'project', 'auth', 'label', 'browse', 'status']);

// How many times a line runs `gh` with `api` or a subcommand the guard cannot read literally (`gh $'a'pi`, `gh "$X"`,
// `gh>/dev/null api`, zsh `=gh`, `gh` as a parameter's value or default: `${X:=gh}`, `${X:-gh}`). Read with quotes and
// backslashes removed, as the shell joins them; `-R`/`--repo` may come first.
function opaqueGhCount(flat) {
  let count = 0;
  for (const m of flat.matchAll(/(?:^|[\s;&|(){}`!=])(?:[^\s;&|(){}`!=]*\/)?gh(?:\.exe)?(?=[\s;&|(){}`<>]|$)/g)) {
    // A bounded window after each match keeps a line of many `gh`s linear; a word cut off there reads as opaque.
    const start = m.index + m[0].length;
    const words = flat.slice(start, start + 512).split(/[\s;&|()<>`]+/).filter(Boolean);
    if (start + 512 < flat.length) words.pop();
    let i = 0;
    while (words[i] === '-R' || words[i] === '--repo' || /^--repo=/.test(words[i] ?? '')) i += words[i].includes('=') ? 1 : 2;
    if (!GH_SUBCOMMANDS.has(words[i])) count++;
  }
  return count + (flat.match(/\$\{[^{}]*(?<![\w.])gh(?:\.exe)?\}/gi)?.length ?? 0);
}
const opaqueGh = (flat) => opaqueGhCount(flat) > 0;

// Whether every `gh` call opaqueGh counts in a line is a plain `gh` command (plainGh) of its own at the top level, in a
// line the shell reader splits cleanly: `echo …; gh api user; git remote -v` is three commands, not an opaque `gh` (G26).
// The calls must add up to the line's: one in a heredoc body (which may be run as a script later) or in a substitution
// or payload is not a plain command. A line that defines `gh` (a function or an alias) never passes.
function plainGhCalls(command) {
  const flat = command.replace(/['"\\]/g, '');
  if (/(?:^|[\s;&|(){}`])(?:function\s+gh(?:\.exe)?\b|gh(?:\.exe)?\s*\(\s*\)|alias\s+(?:-\S+\s+)*gh=)/.test(flat)) return false;
  const a = analyze(command);
  if (a.opaque) return false;
  let found = 0;
  for (const { cmd, depth } of units(a)) {
    const n = opaqueGhCount(cmd.raw.replace(/['"\\]/g, ''));
    if (!n) continue;
    // A read only: a plain `gh <word>` may be an alias or extension that writes.
    const args = plainGh(cmd.raw);
    if (n !== 1 || depth !== 0 || cmd.payloads.length || args === null || ghAction(args) !== 'read') return false;
    found++;
  }
  return found === opaqueGhCount(flat);
}

// Whether one plain `gh` command sends a body the guard cannot read to a labels or issues endpoint.
function unreadableBody(args) {
  const action = ghAction(args);
  if (!action || action === 'read') return action !== 'read';
  const path = action.write.split('?')[0].replace(/\/+$/, '');
  return !(/\/comments(?:\/\d+)?$/.test(path) || (path && !/(?:^|\/)(?:labels|issues)(?:\/|$)/.test(path)));
}

// Whether one glob alternative matches `target` (lowercase), ignoring case as macOS and Windows do. Linear: the pattern is
// read once into tokens, runs of `*` collapse, and a table over the short target replaces regex backtracking (a word of
// a hundred stars hung the hook). A POSIX class (`[[:alpha:]]`) is not parsed: it counts as a match.
function globMatches(pattern, target) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (tokens.at(-1) !== '*') tokens.push('*');
    } else if (c === '?') tokens.push((ch) => true);
    else if (c === '[' && pattern.indexOf(']', i + 2) > 0) {
      const end = pattern.indexOf(']', i + 2);
      let body = pattern.slice(i + 1, end);
      if (body.includes('[:') || body.includes('[=') || body.includes('[.')) return true;
      const negate = /^[!^]/.test(body);
      if (negate) body = body.slice(1);
      const has = (ch) => {
        for (let k = 0; k < body.length; k++) {
          if (body[k + 1] === '-' && k + 2 < body.length) {
            if (ch >= body[k] && ch <= body[k + 2]) return true;
            k += 2;
          } else if (body[k] === ch) return true;
        }
        return false;
      };
      // Either case may name the file: a class matches when it takes either one, a negated class when it lacks either.
      tokens.push((ch) => (negate ? !(has(ch) && has(ch.toUpperCase())) : has(ch) || has(ch.toUpperCase())));
      i = end;
    } else {
      const lower = c.toLowerCase();
      tokens.push((ch) => ch === lower);
    }
  }
  let dp = Array.from({ length: target.length + 1 }, (_, j) => j === 0);
  for (const t of tokens) {
    const next = new Array(target.length + 1).fill(false);
    if (t === '*') {
      let any = false;
      for (let j = 0; j <= target.length; j++) next[j] = any = any || dp[j];
    } else for (let j = 0; j < target.length; j++) next[j + 1] = dp[j] && t(target[j]);
    dp = next;
  }
  return dp[target.length];
}

// Whether a glob or brace word (basename) could name `gh` or `gh.exe`. One level of `{a,b}` is expanded, at most 64
// alternatives; `{a..b}`, a second brace group or a word over 256 characters counts as a match.
function globMatchesGh(word) {
  const name = word.split('/').pop();
  if (name.length > 256) return true;
  const brace = /\{([^{}]*)\}/.exec(name);
  let alts = [name];
  if (brace) {
    const parts = brace[1].split(',');
    if (brace[1].includes('..') || /[{}]/.test(name.slice(brace.index + brace[0].length)) || parts.length > 64) return true;
    alts = parts.map((p) => name.slice(0, brace.index) + p + name.slice(brace.index + brace[0].length));
  }
  return alts.some((alt) => globMatches(alt, 'gh') || globMatches(alt, 'gh.exe'));
}

// Whether one word may name `gh` without spelling it: a name that decodes to `gh` (or `gh.exe`, trailing dots allowed,
// which Windows drops) only with case folded, an ANSI-C string read or a trailing dot, or a glob or brace list that
// could match it.
function hidesGh(w) {
  const spelled = w.raw.replace(/['"\\]/g, '');
  if (/^gh(?:\.exe)?\.*$/i.test(w.val.split('/').pop()) && !/(?:^|\/)gh(?:\.exe)?$/.test(spelled)) return true;
  return !/[$`]/.test(w.raw) && dynamicText(w.raw) && globMatchesGh(w.val);
}

// A command, at any depth, that the shell may resolve to `gh` though its text does not spell `gh` (hidesGh). The text
// checks above never see such a call. Every word up to the command is read, past reserved words (`then`, `{`, `!`,
// `coproc`), and a unit that starts with a known wrapper is read whole, since the reader cannot tell a wrapper's option
// values from the command (`sudo -E -u x …`, `timeout -s KILL 5 nice …`). A name the shell builds from a variable
// (`$GH`) stays out of sight, and so does a command behind a wrapper the reader does not know (`stdbuf`, `watch`).
export function ghHidden(command) {
  const plain = (w) => !w.val.startsWith('-') && !/^[A-Za-z_]\w*=/.test(w.val);
  for (const { cmd } of units(analyze(command))) {
    const words = dropReserved(cmd.words);
    const head = words.find(plain);
    let at = words.length - commandWords(words).length;
    // A word the reader took for the command that is an option or a duration (`time -p X`, `timeout -s KILL 5 X`): read on.
    while (at < words.length - 1 && (words[at].val.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(words[at].val))) at++;
    const read = head && WRAPPERS.has(head.val.replace(/^.*[\\/]/, '').toLowerCase()) ? words : words.slice(0, at + 1);
    if (read.some((w) => plain(w) && hidesGh(w))) return true;
  }
  return false;
}

// A plain `gh` command whose real command the guard cannot see: an alias or extension (`gh <name>` that is not one of gh's
// own commands), or one that makes, swaps or runs one (`gh alias set|import`, `gh extension install|upgrade|remove|exec`). Other lines are left to
// touchesApprovalLabel, which denies a non-plain `gh` with an unknown subcommand already.
export function ghUnseen(command, rules) {
  const args = plainGh(command.replace(/\\\r?\n/g, ''));
  if (!args) return false;
  const positional = [];
  for (let i = 0; i < args.length && positional.length < 2; i++) {
    if (['-R', '--repo', '--hostname'].includes(args[i])) i++;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  const [cmd, sub] = positional;
  if (cmd === undefined) return false;
  if (!rules.factory.ghCommands.includes(cmd)) return true;
  return (cmd === 'alias' && ['set', 'import'].includes(sub)) || (['extension', 'extensions', 'ext'].includes(cmd) && ['install', 'upgrade', 'remove', 'exec'].includes(sub));
}

// Fail closed while a factory run is active. A command that names the label, approval or takeover (in any quoting or case, as
// GitHub compares), is denied unless it is one plain `gh` read; adding and removing alike are the owner's. A `gh` command with a
// body the guard cannot read (`--input`, a `key=@file` field) is denied unless it is one plain `gh api` call writing to
// a `/comments` endpoint or a path outside `/labels` and `/issues`; so is any other line running `gh api` (opaqueGh) unless
// each such call in it is a plain command (plainGhCalls). A label the shell builds (`$L`) stays out of sight
// (docs/guard.md).
export function touchesApprovalLabel(command, label) {
  const want = String(label).trim().toLowerCase();
  if (!want) return false;
  // A backslash-newline is a line continuation: the shell joins the word (`agent-o\⏎k`).
  command = command.replace(/\\\r?\n/g, '');
  const named = new RegExp(`(?<![\\w-])${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i');
  const flat = command.replace(/['"\\]/g, '');
  const args = plainGh(command);
  const action = args && ghAction(args);
  // A glued short flag is read without its flag (`-lagent-ok`).
  if (named.test(command) || flat.split(/\s+/).some((w) => named.test(w) || named.test(w.replace(/^-[A-Za-z]=?/, '')))) return action !== 'read';
  // A Windows path to gh (`C:\…\gh.exe`) loses its backslashes in `flat`: deny it outright.
  if (!args && /\\gh(?:\.exe)?(?![\w-])/i.test(command)) return true;
  // A line of several commands passes when each `gh api` call in it is plain; the label and body checks cover the line.
  if (!args && opaqueGh(flat) && !plainGhCalls(command)) return true;
  // A body in a line of several commands is not matched to its call: denied, as before.
  if (/\bgh\b/.test(flat) && /--input\b|=@/.test(flat)) return args ? unreadableBody(args) : true;
  return false;
}

// Whether a word's text changes at run time: a parameter or command substitution, or an unquoted glob or brace
// list. `$'…'` is not: the reader already decoded it into the word's value.
function dynamicText(raw) {
  for (let i = 0, q = null; i < raw.length; i++) {
    const c = raw[i];
    if (q === "'") q = c === "'" ? null : q;
    else if (c === '\\') i++;
    else if (c === '`' || (c === '$' && /[\w{(@*#?!$-]/.test(raw[i + 1] ?? ''))) return true;
    else if (q === '"') q = c === '"' ? null : q;
    else if (c === "$" && raw[i + 1] === "'") i = raw.indexOf("'", i + 2) < 0 ? raw.length : raw.indexOf("'", i + 2);
    else if (c === "'" || c === '"') q = c;
    else if (/[*?[]/.test(c) || (c === '{' && /^\{[^}]*(?:,|\.\.)[^}]*\}/.test(raw.slice(i)))) return true;
  }
  return false;
}
// Whether a word holds an expansion outside double quotes, which the shell splits into more words: a value can then
// carry a flag (`-b $F` with F='y --label x').
function unquotedExpansion(raw) {
  for (let i = 0, q = null; i < raw.length; i++) {
    const c = raw[i];
    if (q === "'") q = c === "'" ? null : q;
    else if (c === '\\') i++;
    else if (q === '"') q = c === '"' ? null : q;
    else if (c === '`' || (c === '$' && /[\w{(@*#?!$-]/.test(raw[i + 1] ?? ''))) return true;
    else if (c === '$' && raw[i + 1] === "'") i = raw.indexOf("'", i + 2) < 0 ? raw.length : raw.indexOf("'", i + 2);
    else if (c === "'" || c === '"') q = c;
  }
  return false;
}
// Words that open a compound command or negate one: the reader keeps them in front of the command they hold
// (`{ gh …`, `then gh …`, `! gh …`, `coproc gh …`, `function f { gh …`).
const RESERVED = new Set(['{', '(', '!', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'coproc']);
function dropReserved(words) {
  let i = 0;
  while (i < words.length) {
    // A named coprocess (`coproc NAME { … }`): the name is not the command.
    if (words[i].val === 'coproc' && /^[{(]$/.test(words[i + 2]?.val ?? '')) i += 2;
    else if (RESERVED.has(words[i].val) && !dynamicText(words[i].raw)) i++;
    else if (words[i].val === 'function') i += 2;
    else break;
  }
  return words.slice(i);
}
// `gh issue|pr create|edit` flags that take no value: a word after one of them is not its value.
const GH_BOOLEAN = new Set(['-d', '--draft', '--dry-run', '-f', '--fill', '--fill-first', '--fill-verbose', '--no-maintainer-edit', '-w', '--web', '-e', '--editor']);

// A `gh issue|pr create|edit` whose flags the text cannot show (#246): a non-literal subcommand, a
// flag name that expands (`--add-${A}el`), a whole word that expands where no value-taking flag precedes it (`"$F"`),
// an unquoted expansion anywhere (the shell splits it into words, flags included), or arguments added by xargs. Quoted
// values pass (`-b "$(cat body.md)"`, `--body-file "$TMPDIR/b.md"`); so does a gh
// command that cannot add labels (`gh pr view $N`). Also any word naming a label flag once the reader decoded it
// (`-$'l'`). Read with the shell reader, so `$'…'` and line continuations are already resolved.
function ghBuildsLabelFlag(command) {
  for (const u of units(analyze(command))) {
    const words = commandWords(dropReserved(u.cmd.words));
    if (words[0]?.val.split(/[\\/]/).pop().replace(/\.exe$/i, '') !== 'gh') continue;
    let i = 1;
    while (words[i] && words[i].val.startsWith('-') && !dynamicText(words[i].raw)) i += ['-R', '--repo', '--hostname'].includes(words[i].val) ? 2 : 1;
    const [group, verb] = [words[i], words[i + 1]];
    if (!group) continue;
    if (dynamicText(group.raw) || (['issue', 'pr'].includes(group.val) && (!verb || dynamicText(verb.raw)))) return true;
    if (!['issue', 'pr'].includes(group.val) || !['create', 'edit'].includes(verb.val)) continue;
    if (u.cmd.words.some((w) => w.val === 'xargs')) return true;
    for (let k = i + 2; k < words.length; k++) {
      const { val, raw } = words[k];
      if (/label/i.test(val.split('=')[0]) || /^-l/.test(val)) return true;
      if (!dynamicText(raw)) continue;
      if (unquotedExpansion(raw)) return true;
      if (val.startsWith('--')) {
        if (dynamicText(raw.split('=')[0])) return true;
      } else if (val.startsWith('-') && val.length > 1) {
        // The flag letter as the shell joins it: `-"$X"` is `-$X`.
        if (/[$`*?[{]/.test(raw.replace(/["']/g, '')[1] ?? '')) return true;
      } else {
        const prev = words[k - 1].val;
        if (!(prev.startsWith('-') && !prev.includes('=') && !GH_BOOLEAN.has(prev) && k - 1 > i + 1)) return true;
      }
    }
  }
  return false;
}

// A command that may change a label: it mentions one (`--add-label`, `/labels`, `gh label`) or a gh, hub or glab line
// passes `-l`, read with line continuations joined and quotes and backslashes removed as the shell joins them
// (`--add-lab''el`), and is not one plain `gh` read.
function changesLabels(command) {
  command = command.replace(/\\\r?\n/g, '');
  const flat = command.replace(/['"\\]/g, '');
  if (!/label/i.test(flat) && !(/\b(?:gh|hub|glab)\b/.test(flat) && /(?:^|\s)-l/.test(flat))) return false;
  const args = plainGh(command);
  return !args || ghAction(args) !== 'read';
}

// `readTool`: the harness has a file-read tool (all but Codex), so a shell read gets a once-per-session hint.
// `worktrees`, `branches`, `regenerable`: facts the adapters gather (worktreeFacts, branchFacts, regenFacts).
export function evaluateCommand({ command, loadedSkills = new Set(), state, host = {}, env = {}, worktrees = {}, branches = {}, regenerable = {}, refs = {}, tags = {}, python = null, readTool = false, factory = null, rules }) {
  // While a factory run is active the agent never touches the approval label: with an owner token it would count as the owner's.
  if (factory && touchesApprovalLabel(command, factory.approval)) return { action: 'deny', rule: 'factory-approval', reason: `${rules.factory.why} The \`${factory.approval}\` label is the owner's to apply or remove; ask on the ticket instead.` }
  if (factory && ghHidden(command)) return { action: 'deny', rule: 'factory-approval', reason: `${rules.factory.why} This command may run \`gh\` under a spelling the guard cannot read (another letter case, an escape, a glob or brace list); spell \`gh\` literally.` }
  if (factory && ghUnseen(command, rules)) return { action: 'deny', rule: 'factory-approval', reason: `${rules.factory.ghUnseenWhy} Use gh's own subcommand (\`gh issue|pr|api …\`) instead of an alias or extension.` }
  // Nor the takeover label: an approver sets it to hand the ticket to an attended run, which removes it once it claimed.
  if (factory?.takeover && touchesApprovalLabel(command, factory.takeover)) return { action: 'deny', rule: 'factory-takeover', reason: `${rules.factory.takeoverWhy} The \`${factory.takeover}\` label is the owner's to apply; ask on the ticket instead.` }
  // Nor a protected path (`.github/**`, `.factory/**`, FACTORY_PROTECTED_PATHS) through a shell write: the runtime counts the deny.
  const shielded = factory && protectedWrite(command, { ...factory.protect, globs: [...rules.factory.protectedPaths, ...(factory.protect?.extra ?? [])] }, env, rules.factory.protectedLimits)
  if (shielded?.target) return { action: 'deny', rule: 'protected-path', reason: `${rules.factory.protectedWhy} \`${shielded.target}\` is a protected path in this run; leave it to the owner and say on the ticket what should change.` }
  if (shielded?.unsure) return { action: 'deny', rule: 'protected-path', reason: `${rules.factory.protectedWhy} The guard could not check this command's writes within its limits (${shielded.unsure}), so it denies them; split the command into smaller ones.` }
  // A config the guard could not read fails closed: every label change is denied, and so is any name it could still find.
  if (factory?.unsure && (changesLabels(command) || (factory.extra ?? []).some((name) => touchesApprovalLabel(command, name)))) return { action: 'deny', rule: 'factory-config', reason: `${rules.factory.unsureWhy} Every label change is denied in this run until the config is fixed; ask on the ticket instead.` }
  if (factory?.unsure && ghBuildsLabelFlag(command)) return { action: 'deny', rule: 'factory-config', reason: `${rules.factory.unsureWhy} This \`gh issue|pr create|edit\` has a subcommand or flag the shell builds at run time, which could add a label. Spell the subcommand and flags literally, quote every value, and pass a body as a value or with a literal \`--body-file\` path.` }
  // Hard denies come first and fire every time, like the title guard. A `when` rule denies only in a repo
  // that adopted that manager; elsewhere it lets the command through with a once-per-session note.
  const denied = deniedBy(command, rules)
  if (denied && (!denied.when || denied.when === python)) return { action: 'deny', rule: denied.id, reason: denied.why }
  const note = denied && !state.reminded.has(denied.id) ? denied.id : null

  const exempt = new Set([...(safeRemoval(command, rules, env, worktrees, regenerable) ? REMOVAL : []), ...(safeBranchDelete(command, rules, branches, env) ? ['branch-delete'] : []), ...(safeRefDelete(command, rules, refs, env) ? ['gh-delete'] : [])]);
  const risky = rules.risky.find((r) => riskyMatch(r, command) && !exempt.has(r.id));
  if (risky) {
    const why = [
      ...Object.entries(worktrees).filter(([, f]) => !f.safe).map(([t, f]) => `\nWorktree ${t}: ${f.why}`),
      ...Object.entries(branches).filter(([, f]) => !f.safe).map(([k, f]) => `\nBranch ${k.slice(k.indexOf('|') + 1)}: ${f.why}`),
      ...Object.entries(refs).filter(([, f]) => !f.safe).map(([k, f]) => `\nRef ${k.slice(k.lastIndexOf('|') + 1)}: ${f.why}`),
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

  const { loadCap, cpuPercentCap, freeFloorGb } = rules.host;
  const strained = (host.load1 ?? 0) > loadCap || (host.cpuPercent ?? 0) > cpuPercentCap || (host.freeGb ?? Infinity) < freeFloorGb;
  if (hostJudged(command, rules, state.reminded) && strained) {
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
  // Moving or deleting a tag no remote has is local bookkeeping, not a release.
  const rule = rules.skills.find((r) => new RegExp(r.match, 'i').test(matchable(command)) && !(r.id === 'release' && localTagsOnly(command, rules, tags, env)));
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

// A subagent spawn that bypasses the typed agents: the built-in Plan agent, an untyped spawn on a judgement-tier model,
// or a typed agent whose model the spawn overrides. A once-per-session hint per case, never a deny.
// `tool`: the spawn tool, lower-cased (`spawn_agent` is Codex, whose built-in roles share bare names with ours).
export function evaluateRouting({ type, model, effort, tool, state, rules }) {
  const r = rules.routing;
  const t = String(type ?? '').trim().toLowerCase();
  const m = String(model ?? '').trim();
  const e = String(effort ?? '').trim().toLowerCase();
  const name = r.aliases[t] ?? t;
  const builtin = tool === 'spawn_agent' && r.codexBuiltin.includes(t);
  const typed = builtin ? undefined : r.typed.find((q) => q === name || (!name.includes(':') && q.endsWith(`:${name}`)));
  let rule, say;
  if (r.plan.includes(t)) {
    rule = 'routing-plan';
    say = `the built-in ${type} agent runs on the session's model. Planning, design and investigation go to a \`dev-tools:driver\` spawn with a plan-only brief`;
  } else if (r.untyped.includes(t) || (!t && m)) {
    if (m && new RegExp(r.judgementModel, 'i').test(m)) {
      rule = 'routing-model';
      say = `an untyped spawn on ${m} does judgement work outside the typed agents. Give it to \`dev-tools:driver\` (\`dev-tools:escalate\` after two failures) without a \`model\``;
    } else if (!m && t) {
      rule = 'routing-untyped';
      say = `an untyped \`${type}\` spawn without a model runs on \`CLAUDE_CODE_SUBAGENT_MODEL\` or the session's model, which a \`/model\` switch re-prices. Spawn a typed agent: \`dev-tools:scout\` for lookups, \`dev-tools:worker\` for routine edits, \`dev-tools:driver\` for judgement`;
    }
  } else if (typed) {
    const allowed = r.overrides[typed] ?? {};
    const over = [m && !(allowed.model && new RegExp(`\\b(?:${allowed.model})\\b`, 'i').test(m)) && `\`model: ${m}\``, e && !(allowed.effort ?? []).includes(e) && `\`effort: ${e}\``].filter(Boolean);
    if (over.length) {
      rule = 'routing-override';
      say = `\`${type}\` carries its model and effort in its definition, and this spawn's ${over.join(' and ')} overrides it. Drop ${over.length > 1 ? 'them' : 'it'} from the spawn`;
    }
  }
  if (!rule || state.reminded.has(rule)) return { action: 'allow' };
  state.reminded.add(rule);
  return { action: 'allow', rule, remind: true, context: `Routing hint: ${say} (\`${r.skill}\`).` };
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

// Whether the host rule judges this command: a heavy command, not already run through the heavy wrapper (which waits
// for its slot and load on its own), and no host deny yet this session (`reminded`).
export function hostJudged(command, rules, reminded) {
  return hit(rules.heavy, command, { remote: false }) && !new RegExp(rules.host.wrapper).test(command) && !reminded.has('host');
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

// The class of a command for telemetry, never its text: the family of the rule that fired, else the family of the
// first program it runs, from a fixed list (anything else is `other`), so no path, argument or secret leaks.
const RULE_FAMILY = {
  rm: 'delete', find: 'delete', 'worktree-rm': 'delete',
  reset: 'git-discard', clean: 'git-discard', discard: 'git-discard', stash: 'git-discard', 'git-rm': 'git-discard',
  'branch-delete': 'git-history', 'push-delete': 'git-history', force: 'git-history', rewrite: 'git-history',
  docker: 'infra', k8s: 'infra', 'cloud-delete': 'infra', terraform: 'infra', disk: 'infra', 'gh-delete': 'infra', merge: 'infra',
  secrets: 'secrets', 'secrets-env': 'secrets', opaque: 'opaque', title: 'title', host: 'host', pip: 'python', poetry: 'python',
  commit: 'skill', pr: 'skill', ruleset: 'skill', worktree: 'skill', release: 'skill',
  'pr-fix': 'hint', pytest: 'hint', 'go-test': 'hint', 'go-lint': 'hint', read: 'hint', edit: 'hint', docs: 'hint', 'guard-error': 'guard-error',
  'routing-plan': 'routing', 'routing-model': 'routing', 'routing-override': 'routing',
};
const PROGRAM_FAMILY = {
  git: 'git', gh: 'github', glab: 'gitlab', az: 'cloud', gcloud: 'cloud', make: 'build', npm: 'node', npx: 'node', node: 'node', pnpm: 'node', yarn: 'node', bun: 'node',
  uv: 'python', uvx: 'python', python: 'python', python3: 'python', pip: 'python', pytest: 'python', go: 'go', cargo: 'rust', docker: 'container', podman: 'container',
  kubectl: 'container', helm: 'container', terraform: 'infra', tofu: 'infra', ssh: 'remote', scp: 'remote', rsync: 'remote', curl: 'network', wget: 'network',
  cat: 'read', head: 'read', tail: 'read', less: 'read', sed: 'text', awk: 'text', grep: 'search', rg: 'search', find: 'search', fd: 'search', ls: 'list', tree: 'list',
  jq: 'text', wc: 'text', sort: 'text', echo: 'shell', printf: 'shell', cd: 'shell', mkdir: 'files', cp: 'files', mv: 'files', rm: 'files', touch: 'files', chmod: 'files',
  claude: 'harness', codex: 'harness', copilot: 'harness', opencode: 'harness', pi: 'harness', chezmoi: 'dotfiles', bw: 'secrets', bws: 'secrets', op: 'secrets',
};
export function cmdClass(rule, command) {
  if (rule) return Object.hasOwn(RULE_FAMILY, rule) ? RULE_FAMILY[rule] : 'other';
  try {
    for (const { cmd } of units(analysis(String(command ?? '')))) {
      const name = commandWords(cmd.words)[0]?.val.replace(/^.*[\\/]/, '');
      if (name && name !== 'cd') return Object.hasOwn(PROGRAM_FAMILY, name) ? PROGRAM_FAMILY[name] : 'other';
    }
  } catch {
    // unreadable: other
  }
  return 'other';
}

