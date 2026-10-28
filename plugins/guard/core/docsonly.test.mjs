import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docsOnly, parseRules, skippable } from './docsonly.mjs'

test('docsOnly: plain docs, docs media, project meta and editor files are skippable', () => {
  const docs = [
    'README.md', 'README', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md', 'docs/guard.md', 'docs/wip/notes.txt', 'docs/img/a.png',
    'pkg/sub/NOTES.mdx', 'guide.rst', 'a.jpg', 'b.jpeg', 'c.gif', 'd.svg', 'e.webp', 'paper.pdf', 'favicon.ico', 'demo.mp4',
    'clip.mov', 'f.woff', 'f.woff2', 'logo.ai', 'logo.psd', 'NOTICE', 'AUTHORS.md', 'CODEOWNERS', '.github/CODEOWNERS',
    'CITATION.cff', '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/FUNDING.yml', '.editorconfig', '.vscode/settings.json', '.idea/workspace.xml', '.DS_Store', 'src/.DS_Store',
  ]
  for (const p of docs) assert.equal(skippable(p), true, p)
  assert.equal(docsOnly(docs), true)
})

test('docsOnly: code, config, data, lockfiles and CI are never skippable by default', () => {
  const never = [
    'src/app.py', 'index.mjs', 'package.json', 'docs/openapi.json', 'config.yaml', 'docs/mkdocs.yml', '.github/ci.yml', 'pyproject.toml',
    '.gitignore', 'docs/.gitignore', '.env.example', 'uv.lock', 'bun.lockb', 'go.sum', 'package-lock.json', 'pnpm-lock.yaml', 'Makefile',
    'docs/Makefile', 'rules.mk', 'nb.ipynb', 'docs/data.csv', 'data.tsv', 't.parquet', 'feed.xml', 'schema.sql', 'x.snap',
    'tests/fixtures/out.md', 'pkg/testdata/golden.txt', 'src/__snapshots__/a.md', 'tests/golden/a.txt', 'requirements.txt',
    'requirements-dev.txt', 'constraints.txt', 'CMakeLists.txt', '.github/workflows/ci.yml', '.github/workflows/README.md',
    '.github/dependabot.yml', '.stop-check-ignore',
  ]
  for (const p of never) assert.equal(skippable(p), false, p)
})

test('docsOnly: a mixed change set runs the check; an empty or missing one does too', () => {
  assert.equal(docsOnly(['README.md', 'src/app.py']), false)
  assert.equal(docsOnly([]), false)
  assert.equal(docsOnly(null), false)
  assert.equal(docsOnly(undefined), false)
})

test('docsOnly: Windows path separators and a leading ./ match like forward slashes', () => {
  assert.equal(docsOnly(['docs\\guide\\setup.md', '.\\README.md', 'img\\a.png']), true)
  assert.equal(skippable('.github\\workflows\\ci.yml'), false)
  assert.equal(skippable('tests\\fixtures\\a.md'), false)
})

test('docsOnly: matching ignores case', () => {
  assert.equal(skippable('readme.MD'), true)
  assert.equal(skippable('Docs/Guide.MD'), true)
  assert.equal(skippable('makefile'), false)
})

test("docsOnly: the repo's rules come last, `!` keeps paths checked and a plain line extends the skip list", () => {
  const repo = '# validated by make validate\n!plugins/**\n\n!AGENTS.md\nsite/**\n*.drawio\n'
  assert.equal(docsOnly(['plugins/dev-tools/skills/wt/SKILL.md'], repo), false)
  assert.equal(docsOnly(['plugins/guard/agents/x.md'], repo), false)
  assert.equal(docsOnly(['AGENTS.md'], repo), false)
  assert.equal(docsOnly(['sub/AGENTS.md'], repo), false) // no slash: any depth
  assert.equal(docsOnly(['docs/guard.md', 'README.md'], repo), true)
  assert.equal(docsOnly(['site/index.html', 'diagrams/flow.drawio'], repo), true)
  assert.equal(docsOnly(['site/index.html']), false) // only with the repo's rule
  // Last match wins: a repo can make a default never-skip file skippable again, and back.
  assert.equal(docsOnly(['docs/data.csv'], 'docs/*.csv'), true)
  assert.equal(docsOnly(['docs/data.csv'], 'docs/*.csv\n!docs/data.csv'), false)
})

test('parseRules: blank lines and comments are dropped, CRLF is read, a trailing / matches a directory at any depth', () => {
  assert.equal(parseRules('# c\r\n\r\n!a\r\nb/\r\n').length, 2)
  assert.equal(docsOnly(['x/build/out.bin'], 'build/'), true)
  assert.equal(docsOnly(['x/build'], 'build/'), false) // a file named build is not the directory
})
