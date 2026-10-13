// Work-item references in the agent's reply made clickable: `#123`, `!45`, `owner/repo#12`, `AB#77` become links to
// the forge of the session's remote (pickRemote: upstream, else origin). Pure but linkRepo, which takes a runner: no
// API calls, so a `#N` on GitHub links to /issues/N, which GitHub redirects to /pull/N for a pull request.
import { forgeOf, ICON } from './weather.mjs'

// One glyph and colour per kind: an issue, a PR or MR, an Azure Boards work item (Nerd Font, as weather.mjs's ICON).
export const KIND = {
  issue: { icon: '', rgb: [166, 227, 161] }, // nf-oct-issue_opened, green
  pr: { icon: ICON.pr, rgb: [203, 166, 247] }, // nf-oct-git_pull_request, mauve as the band's merged PR
  workitem: { icon: '', rgb: [137, 180, 250] }, // nf-oct-tasklist, blue
}

// The repository a remote URL names: { forge, host, path } for GitHub (github.com or an Enterprise host) and GitLab,
// { forge: 'azure', org, project, repo } for Azure DevOps; null for any other forge or an unreadable URL.
// Takes https://host/path(.git), ssh://user@host[:port]/path and scp-like user@host:path.
export function repoOf(remote) {
  const url = remote?.trim()
  if (!url) return null
  const forge = forgeOf(url) ?? (/github/i.test(url) ? 'github' : null)
  const m = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(url)
  if (!forge || !m) return null
  const [, host, path] = m
  if (forge !== 'azure') return { forge, host, path }
  const p = path.split('/')
  // dev.azure.com/org/project/_git/repo, ssh.dev.azure.com:v3/org/project/repo, org.visualstudio.com/[DefaultCollection/]project/_git/repo
  if (p[0] === 'v3' && p.length === 4) return { forge, org: p[1], project: p[2], repo: p[3] }
  const git = p.indexOf('_git')
  if (git < 1 || !p[git + 1]) return null
  const vs = /^([^.]+)\.visualstudio\.com$/i.exec(host)
  return { forge, org: vs ? vs[1] : p[0], project: p[git - 1], repo: p[git + 1] }
}

// The remote whose forge holds the work items, from `git remote`'s names: upstream in a fork (its issues and PRs live
// on the parent), else origin, else the first; null without one.
export function pickRemote(names) {
  const n = (names ?? '').split(/\s+/).filter(Boolean)
  return n.includes('upstream') ? 'upstream' : n.includes('origin') ? 'origin' : (n[0] ?? null)
}

// The repository references link to, read through run(argv) -> stdout | null (git in the session's directory).
export async function linkRepo(run) {
  const name = pickRemote(await run(['git', 'remote']))
  return name ? repoOf(await run(['git', 'remote', 'get-url', name])) : null
}

// The link and kind of one reference, or null where the forge has no such reference.
// ref: { repo?: 'owner/repo' (another repository), sigil: '#' | '!' | 'AB#', n }.
export function target(r, { repo, sigil, n }) {
  if (!r) return null
  // A GitHub repository is exactly owner/repo; a deeper path (`docs/x/y#1`) is no reference.
  if (r.forge === 'github') return sigil === '#' && (!repo || /^[\w-]+\/[\w.-]+$/.test(repo)) ? { url: `https://${r.host}/${repo ?? r.path}/issues/${n}`, kind: 'issue' } : null
  if (r.forge === 'gitlab') {
    const base = `https://${r.host}/${repo ?? r.path}`
    return sigil === '#' ? { url: `${base}/-/issues/${n}`, kind: 'issue' } : sigil === '!' ? { url: `${base}/-/merge_requests/${n}`, kind: 'pr' } : null
  }
  if (repo) return null // Azure DevOps has no owner/repo#N
  const base = `https://dev.azure.com/${r.org}/${r.project}`
  return sigil === '!' ? { url: `${base}/_git/${r.repo}/pullrequest/${n}`, kind: 'pr' } : { url: `${base}/_workitems/edit/${n}`, kind: 'workitem' }
}

// Spans left as written (code spans, markdown links, autolinks, bare URLs), then a reference: a word boundary before
// it (not `&#1;`, `a/#1`, `x#1`), `owner/repo` (first segment without a dot, so `github.com/o/r#1` is no reference)
// or `AB`, the sigil, digits, and no word character after (`#fff`, `#1a2b` are colours, `#!` a shebang).
const SPAN = /(`+)[^`]*?\1|\[[^\]\n]*\]\([^)\n]*\)|<[a-z][\w+.-]*:[^>\n]*>|\b[a-z][\w+.-]*:\/\/[^\s)>]+|(?<![\w&/#!@.\\-])(?:([\w-]+(?:\/[\w.-]+)+)|(AB))?([#!])(\d+)(?![\w-])/g
const FENCE = /^ {0,3}(```|~~~)/

// The text with each reference made a link. format: 'markdown' writes `[ref](url)` for a renderer that draws links
// (Claude Code, pi); 'ansi' writes an OSC 8 hyperlink for a raw terminal. glyph puts the kind's icon before the
// reference; color (ansi only: markdown has no colour) paints it in the kind's colour. Fenced code is left alone.
export function linkify(text, remote, { format = 'markdown', glyph = false, color = false } = {}) {
  const r = typeof remote === 'string' ? repoOf(remote) : remote
  if (!r || !text) return text
  let fence = null
  return text
    .split('\n')
    .map((line) => {
      const f = FENCE.exec(line)?.[1]
      if (fence) {
        if (f === fence) fence = null
        return line
      }
      if (f) {
        fence = f
        return line
      }
      return line.replace(SPAN, (all, _tick, repo, ab, sigil, n) => {
        if (!n || (ab && sigil !== '#')) return all
        const t = target(r, { repo, sigil: ab ? 'AB#' : sigil, n })
        if (!t) return all
        const k = KIND[t.kind]
        const label = glyph ? `${k.icon} ${all}` : all
        if (format === 'markdown') return `[${label}](${t.url})`
        const painted = color ? `\x1b[38;2;${k.rgb.join(';')}m${label}\x1b[39m` : label
        return `\x1b]8;;${t.url}\x1b\\${painted}\x1b]8;;\x1b\\`
      })
    })
    .join('\n')
}

// Glyphs and colour unless NO_COLOR is set (https://no-color.org: any non-empty value).
export const styled = (env) => !env?.NO_COLOR
