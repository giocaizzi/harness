// Which changes the stop check may skip: a change set made only of plain docs (README, docs/, *.md, images, ...).
// Pure: the stop hook lists the changed paths and reads the repo's `.stop-check-ignore`; this decides.
//
// Rules are gitignore-style patterns, evaluated in order, the last match winning: a plain pattern marks a path
// skippable, a `!pattern` marks it as needing the check. A path no rule matches needs the check. A pattern without
// a `/` matches the file name at any depth (`*.md`); one with a `/` is anchored at the repo root (`docs/**`); `**`
// spans directories, `*` and `?` do not. Matching ignores case (macOS and Windows file systems do too).

// The default list: plain docs, docs media, project meta, editor and OS files, then what is never skipped by default
// even where a docs pattern above matches it (config, data, fixtures, lockfiles, CI), then the paths that are skipped
// whatever their type: .github's issue and PR templates and funding file, and the editors' settings directories.
export const DEFAULT_RULES = `
README*
CHANGELOG*
LICENSE*
CONTRIBUTING*
CODE_OF_CONDUCT*
SECURITY*
docs/**
*.md
*.mdx
*.txt
*.rst
*.adoc
*.png
*.jpg
*.jpeg
*.gif
*.svg
*.webp
*.pdf
*.ico
*.mp4
*.mov
*.woff
*.woff2
*.ai
*.psd
NOTICE*
AUTHORS*
CODEOWNERS
CITATION.cff
.editorconfig
.DS_Store
!*.json
!*.yaml
!*.yml
!*.toml
!.gitignore
!.env.example
!*.lock
!*.lockb
!go.sum
!Makefile
!*.mk
!*.ipynb
!*.csv
!*.tsv
!*.parquet
!*.xml
!*.sql
!*.snap
!**/fixtures/**
!**/testdata/**
!**/__snapshots__/**
!**/golden/**
!requirements*.txt
!constraints*.txt
!CMakeLists.txt
!.github/workflows/**
!.github/dependabot.yml
.github/ISSUE_TEMPLATE/**
.github/PULL_REQUEST_TEMPLATE*
.github/FUNDING.yml
.vscode/**
.idea/**
`

const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

function toRegex(pattern) {
  const anchored = pattern.replace(/\/$/, '').includes('/')
  const body = pattern.replace(/^\//, '').replace(/\/$/, '/**')
  let re = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '*' && body[i + 1] === '*') {
      if (body[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += escape(c)
  }
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}$`, 'i')
}

// One rule per non-empty line; `#` starts a comment line. Returns [{ skip, re }].
export function parseRules(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!') ? { skip: false, re: toRegex(l.slice(1)) } : { skip: true, re: toRegex(l) }))
}

const DEFAULTS = parseRules(DEFAULT_RULES)

// Whether one repo-relative path may skip the check under `rules` (defaults first, then the repo's own).
export function skippable(path, rules = DEFAULTS) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.\//, '')
  let skip = false
  for (const r of rules) if (r.re.test(p)) skip = r.skip
  return skip
}

// True only when every path is skippable; an empty or missing list is never docs-only, so the check runs.
// `repoRules` is the text of the repo's `.stop-check-ignore`, appended after the defaults.
export function docsOnly(paths, repoRules = '') {
  if (!Array.isArray(paths) || !paths.length) return false
  const rules = repoRules ? [...DEFAULTS, ...parseRules(repoRules)] : DEFAULTS
  return paths.every((p) => skippable(p, rules))
}
