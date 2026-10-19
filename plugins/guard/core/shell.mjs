// A small shell reader for the guard: enough of POSIX sh, bash and the Windows shells to see what a command runs.
// Pure, no I/O. It splits a command into simple commands, blanks quoted text (data, not code), drops heredoc bodies
// and comments, and finds the payloads that run as code although they are written as data:
//   - the string after a shell's -c (combined flags like -lc, `--`, $'…' quoting), eval's arguments,
//     cmd /c, powershell|pwsh -Command, a heredoc or echo/printf/cat piped into a shell,
//   - ssh's remote command (marked remote, with the host), docker|podman|kubectl exec's command,
//   - $(…) and `…` anywhere outside single quotes, double-quoted ones included.
// Each payload is read again the same way, three levels deep at most. What cannot be read statically (an encoded
// PowerShell command, base64 decoded into a shell, nesting past the cap) marks the command opaque.

const MAX_DEPTH = 3
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox'])
const POWERSHELLS = new Set(['pwsh', 'powershell', 'pwsh.exe', 'powershell.exe'])
// Words that run the next word as the command: skipped to find what actually runs.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'doas', 'caffeinate'])
// Options of the wrappers above that take a value.
const WRAPPER_VALUE = new Set(['-u', '-g', '-C', '-h', '-p', '-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a', '-S', '--user', '--group', '-k', '-i', '-w', '-t'])
// ssh options that take a value (OpenSSH): everything else is a flag.
const SSH_VALUE = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'])
const EXEC_VALUE = new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '--env-file', '-c', '--container', '-n', '--namespace', '--detach-keys'])
const DECODERS = /^(?:base64|gbase64|openssl|xxd|uudecode)$/
const ASSIGNMENT = /^[A-Za-z_]\w*=/

const basename = (w) => w.replace(/^.*[\\/]/, '').toLowerCase()

// ANSI-C quoting ($'…'): the common escapes.
function ansiC(s) {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (m, e) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }[e] ?? e
  })
}

// The index just past the `)` closing a `$(` or `(` that opens at `i` (src[i] is the first char inside), quotes and
// nesting respected. src.length when unbalanced.
function closeParen(src, i) {
  let depth = 1
  let heredocs = []
  while (i < src.length) {
    const c = src[i]
    const doc = c === '<' && /^<<(-?)\s*(['"]?)(\w+)\2/.exec(src.slice(i))
    if (doc && src[i + 2] !== '<') {
      heredocs.push({ delim: doc[3], strip: doc[1] === '-' })
      i += doc[0].length
    } else if (c === '\n' && heredocs.length) {
      i++
      for (const h of heredocs) {
        while (i < src.length) {
          const nl = src.indexOf('\n', i)
          const line = src.slice(i, nl < 0 ? src.length : nl)
          i = nl < 0 ? src.length : nl + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        }
      }
      heredocs = []
    } else if (c === '\\') i += 2
    else if (c === "'") i = (src.indexOf("'", i + 1) + 1 || src.length + 1) - 0
    else if (c === '"') i = closeDouble(src, i + 1)
    else if (c === '`') i = (src.indexOf('`', i + 1) + 1 || src.length + 1) - 0
    else if (c === '(') (depth++, i++)
    else if (c === ')') {
      if (--depth === 0) return i + 1
      i++
    } else i++
  }
  return src.length
}

// The index just past the `"` closing a double-quoted string whose content starts at `i`.
function closeDouble(src, i) {
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\') i += 2
    else if (src.startsWith('$(', i) && !src.startsWith('$((', i)) i = closeParen(src, i + 2)
    else if (src[i] === '`') i = (src.indexOf('`', i + 1) + 1) || src.length
    else i++
  }
  return i + 1
}

const OPS = ['&&', '||', '|&', ';;', ';', '|', '&', '\n', '(', ')']

// Reads `src` into simple commands: { raw, code, words: [{ val, raw, substs: [{ text, quoted }] }], heredocs: [body],
// sep } where `sep` is the operator before it. `code` is the command with quoted strings as "", heredoc bodies
// dropped and comments removed: what rules match.
export function scan(src) {
  const commands = []
  let cur = null
  let sep = ''
  const pending = [] // heredocs waiting for the end of the line: { delim, strip, cmd }
  const start = (i) => {
    if (!cur) cur = { start: i, end: i, code: '', words: [], heredocs: [], sep }
  }
  const finish = () => {
    if (cur && (cur.words.length || cur.code.trim())) commands.push(cur)
    cur = null
  }
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      if (cur) cur.code += c
      i++
      continue
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(src[i - 1]))) {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    const op = !src.startsWith('&>', i) && OPS.find((o) => src.startsWith(o, i))
    if (op && !(op === '(' && cur && /[=@?*+!]$/.test(cur.code))) {
      if (cur) cur.end = i
      finish()
      sep = op
      i += op.length
      if (op === '\n' && pending.length) i = readHeredocs(src, i, pending)
      continue
    }
    start(i)
    // A redirection: `<<`/`<<-` opens a heredoc; `<<<`, `>`, `>>`, `<`, `>&`, `&>`, `2>` take one word.
    const redir = /^[<>]\(/.test(src.slice(i, i + 2)) ? null : /^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||>|<)/.exec(src.slice(i))
    if (redir) {
      i += redir[0].length
      while (src[i] === ' ' || src[i] === '\t') i++
      const target = readWord(src, i)
      i = target.end
      if (redir[2] === '<<' || redir[2] === '<<-') {
        pending.push({ delim: target.word.val, strip: redir[2] === '<<-', cmd: cur })
        cur.code += ` ${redir[0]}${target.word.val} `
      } else cur.code += ` ${redir[0]}${target.code} `
      continue
    }
    const { word, code, end } = readWord(src, i)
    cur.words.push(word)
    cur.code += code
    i = end
  }
  if (cur) cur.end = n
  finish()
  for (const cmd of commands) cmd.raw = src.slice(cmd.start, cmd.end).trim()
  return commands
}

// Heredoc bodies after the newline at `i`, in order; returns the index after the last delimiter line.
function readHeredocs(src, i, pending) {
  for (const h of pending.splice(0)) {
    const lines = []
    while (i < src.length) {
      const nl = src.indexOf('\n', i)
      const line = src.slice(i, nl < 0 ? src.length : nl)
      i = nl < 0 ? src.length : nl + 1
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
      lines.push(h.strip ? line.replace(/^\t+/, '') : line)
    }
    h.cmd.heredocs.push(lines.join('\n'))
  }
  return i
}

// One word from `i`: its value (quotes removed, escapes applied), its code (quoted parts as ""), the command
// substitutions in it, and where it ends.
function readWord(src, i) {
  const word = { val: '', raw: '', substs: [], quoted: false }
  let code = ''
  const begin = i
  while (i < src.length) {
    const c = src[i]
    if (/[\s;&|()<>]/.test(c)) {
      // `<(…)`/`>(…)` process substitution and `=(` (zsh) are part of the word.
      if ((c === '<' || c === '>') && src[i + 1] === '(') {
        const end = closeParen(src, i + 2)
        word.substs.push({ text: src.slice(i + 2, end - 1), quoted: false })
        word.val += src.slice(i, end)
        code += src.slice(i, end)
        i = end
        continue
      }
      break
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      word.val += src[i + 1] ?? ''
      code += src.slice(i, i + 2)
      i += 2
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1)
      const stop = end < 0 ? src.length : end
      word.val += src.slice(i + 1, stop)
      word.quoted = true
      code += '""'
      i = stop + 1
    } else if (c === '$' && src[i + 1] === "'") {
      let j = i + 2
      while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1
      word.val += ansiC(src.slice(i + 2, j))
      word.quoted = true
      code += '""'
      i = j + 1
    } else if (c === '"') {
      const end = closeDouble(src, i + 1)
      const inner = src.slice(i + 1, end - 1)
      word.val += inner.replace(/\\([$`"\\\n])/g, '$1')
      word.quoted = true
      for (const s of substitutions(inner)) word.substs.push({ text: s, quoted: true })
      code += '""'
      i = end
    } else if (c === '$' && src[i + 1] === '(' && src[i + 2] !== '(') {
      const end = closeParen(src, i + 2)
      const inner = src.slice(i + 2, end - 1)
      word.substs.push({ text: inner, quoted: false })
      word.val += src.slice(i, end)
      code += `$(${codeOf(inner)})`
      i = end
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1)
      const stop = end < 0 ? src.length : end
      word.substs.push({ text: src.slice(i + 1, stop), quoted: false })
      word.val += src.slice(i, stop + 1)
      code += `\`${codeOf(src.slice(i + 1, stop))}\``
      i = stop + 1
    } else if (c === '$' && src[i + 1] === '(') {
      const end = closeParen(src, i + 2)
      word.val += src.slice(i, end)
      code += src.slice(i, end)
      i = end
    } else if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i)
      const stop = end < 0 ? src.length : end + 1
      word.val += src.slice(i, stop)
      code += src.slice(i, stop)
      i = stop
    } else {
      word.val += c
      code += c
      i++
    }
  }
  word.raw = src.slice(begin, i)
  return { word, code, end: i }
}

// The $(…) and `…` substitutions inside a double-quoted string's content.
function substitutions(inner) {
  const out = []
  let i = 0
  while (i < inner.length) {
    if (inner[i] === '\\') i += 2
    else if (inner.startsWith('$(', i) && !inner.startsWith('$((', i)) {
      const end = closeParen(inner, i + 2)
      out.push(inner.slice(i + 2, end - 1))
      i = end
    } else if (inner[i] === '`') {
      const end = inner.indexOf('`', i + 1)
      const stop = end < 0 ? inner.length : end
      out.push(inner.slice(i + 1, stop))
      i = stop + 1
    } else i++
  }
  return out
}

// The code of a fragment (quoted text as "", heredoc bodies and comments dropped), operators kept.
export const codeOf = (src) => scan(src).map((c) => `${c.sep && c.sep !== '\n' ? `${c.sep} ` : ''}${c.code.trim()}`).join(' ').trim()

// The words of a simple command after prefix assignments and wrappers (sudo, env, xargs, …): what it runs.
export function commandWords(words) {
  let k = 0
  while (k < words.length && ASSIGNMENT.test(words[k].val)) k++
  while (k < words.length && WRAPPERS.has(basename(words[k].val))) {
    const wrapper = basename(words[k].val)
    k++
    if (wrapper === 'timeout' && words[k] && !words[k].val.startsWith('-')) k++
    while (k < words.length && (words[k].val.startsWith('-') || (wrapper === 'env' && ASSIGNMENT.test(words[k].val)))) {
      k += WRAPPER_VALUE.has(words[k].val) ? 2 : 1
    }
  }
  return words.slice(k)
}

// Re-quotes argv words as one command line: a word with anything a shell would split or expand is single-quoted.
const requote = (words) => words.map((w) => (/^[\w./@%+=:,~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')

// The payloads of one simple command (see the header), each { kind, text, remote?, host?, injected? }, plus
// `opaque` when it runs code the guard cannot read. `prev` is the command before it in the same pipeline.
function payloadsOf(cmd, prev) {
  const out = []
  let opaque = false
  // Substitutions run first, in this shell. One that is the whole value of an assignment, double-quoted
  // (`TOKEN="$(keyring read)" ./deploy`), injects a value into an environment, never into output.
  for (const w of cmd.words) {
    const injected = /^[A-Za-z_]\w*="\$\([\s\S]*\)"$/.test(w.raw) && w.substs.length === 1
    for (const s of w.substs) out.push({ kind: 'subst', text: s.text, injected })
  }
  const words = commandWords(cmd.words)
  const name = words[0] ? basename(words[0].val) : ''
  const args = words.slice(1)
  if (SHELLS.has(name)) {
    let c = false
    let k = 0
    for (; k < args.length; k++) {
      const a = args[k].val
      if (a === '--') {
        k++
        break
      }
      if (!/^[-+]/.test(a)) break
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) c = true
      if (/^[-+]o$|^[-+]O$|^--(?:rcfile|init-file)$/.test(a)) k++
    }
    if (c && args[k]) out.push({ kind: 'shell', text: args[k].val })
    else if (!c && !args.slice(k).length) {
      for (const body of cmd.heredocs) out.push({ kind: 'shell', text: body })
      if (prev) {
        const from = commandWords(prev.words)
        const fromName = from[0] ? basename(from[0].val) : ''
        if (prev.decoder) opaque = true
        else if (fromName === 'echo') out.push({ kind: 'shell', text: from.slice(1).filter((w) => !/^-[neE]+$/.test(w.val)).map((w) => w.val).join(' ') })
        else if (fromName === 'printf') out.push({ kind: 'shell', text: ansiC(from[1]?.val ?? '') })
        else if (fromName === 'cat' && prev.heredocs.length) for (const body of prev.heredocs) out.push({ kind: 'shell', text: body })
      }
    }
  } else if (name === 'eval') {
    out.push({ kind: 'shell', text: args.map((w) => w.val).join(' ') })
  } else if (POWERSHELLS.has(name)) {
    const k = args.findIndex((w) => /^-(?:c|command)$/i.test(w.val))
    if (args.some((w) => /^-(?:e|ec|enc|encodedcommand)$/i.test(w.val))) opaque = true
    else if (k >= 0) out.push({ kind: 'shell', text: args.slice(k + 1).map((w) => w.val).join(' ') })
  } else if (name === 'cmd' || name === 'cmd.exe') {
    const k = args.findIndex((w) => /^\/[ck]$/i.test(w.val))
    if (k >= 0) out.push({ kind: 'shell', text: args.slice(k + 1).map((w) => w.val).join(' ') })
  } else if (name === 'ssh') {
    let k = 0
    while (k < args.length && args[k].val.startsWith('-')) k += SSH_VALUE.has(args[k].val) ? 2 : 1
    const host = args[k]?.val
    const rest = args.slice(k + 1).map((w) => w.val).join(' ')
    if (host && rest) out.push({ kind: 'ssh', text: rest, remote: true, host: host.replace(/^.*@/, '') })
    else if (host) for (const body of cmd.heredocs) out.push({ kind: 'ssh', text: body, remote: true, host: host.replace(/^.*@/, '') })
  } else if (['docker', 'podman', 'nerdctl', 'kubectl', 'oc'].includes(name)) {
    let k = args.findIndex((w) => w.val === 'exec')
    if (k >= 0) {
      if (name === 'kubectl' || name === 'oc') {
        const dash = args.findIndex((w) => w.val === '--')
        k = dash
      } else {
        k++
        while (k < args.length && args[k].val.startsWith('-')) k += EXEC_VALUE.has(args[k].val) ? 2 : 1
      }
      // The container's files are not this machine's: judged like a remote host.
      const container = name === 'kubectl' || name === 'oc' ? args.slice(args.findIndex((w) => w.val === 'exec') + 1).find((w) => !w.val.startsWith('-'))?.val : args[k]?.val
      if (k >= 0 && args[k + 1]) out.push({ kind: 'exec', text: requote(args.slice(k + 1).map((w) => w.val)), remote: true, host: `${name}:${container}` })
    }
  }
  return { payloads: out, opaque }
}

// The whole analysis of a command: { commands: [{ raw, code, words, heredocs, sep, payloads: [{ kind, text, remote,
// host, injected, analysis }] }], opaque }. Payloads are analysed again, MAX_DEPTH levels at most.
export function analyze(src, depth = 0) {
  const commands = scan(src)
  let opaque = false
  commands.forEach((cmd, i) => {
    const prev = cmd.sep === '|' || cmd.sep === '|&' ? commands[i - 1] : null
    const name = commandWords(cmd.words)[0]?.val ?? ''
    const args = commandWords(cmd.words).slice(1).map((w) => w.val)
    // A decoder in a pipeline: what it decodes cannot be read, so a shell it feeds is opaque.
    cmd.decoder = (prev?.decoder ?? false) || (DECODERS.test(basename(name)) && args.some((a) => /^(?:-d|--decode|-D|-r|-base64)$/.test(a)))
    const found = payloadsOf(cmd, prev)
    if (found.opaque) opaque = true
    cmd.payloads = found.payloads.map((p) => {
      if (depth + 1 > MAX_DEPTH) {
        opaque = true
        return { ...p, analysis: { commands: [], opaque: true } }
      }
      const analysis = analyze(p.text, depth + 1)
      if (analysis.opaque) opaque = true
      return { ...p, analysis }
    })
  })
  return { commands, opaque }
}

// Every simple command of an analysis, payloads included, depth-first in order: { cmd, remote, host, injected,
// depth, siblings } where `siblings` is how many commands share its level (the chain or the payload it is in).
export function units(analysis, ctx = { remote: false, host: undefined, injected: false, depth: 0 }) {
  const out = []
  const siblings = analysis.commands.filter((c) => !/^(?:do|done|then|fi|else|esac|\{|\})?$/.test(c.code.trim())).length
  for (const cmd of analysis.commands) {
    out.push({ cmd, ...ctx, siblings })
    for (const p of cmd.payloads) {
      out.push(...units(p.analysis, { remote: ctx.remote || Boolean(p.remote), host: p.host ?? ctx.host, injected: ctx.injected || Boolean(p.injected), depth: ctx.depth + 1, kind: p.kind }))
    }
  }
  return out
}
