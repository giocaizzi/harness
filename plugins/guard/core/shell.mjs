// A small shell reader for the guard: enough of POSIX sh, bash and the Windows shells to see what a command runs.
// Pure, no I/O. It splits a command into simple commands, blanks quoted text (data, not code), drops heredoc bodies
// and comments, and finds the payloads that run as code although they are written as data:
//   - the string after a shell's -c (combined flags like -lc, `--`, $'…' quoting), eval's arguments,
//     cmd /c, powershell|pwsh -Command, a heredoc or echo/printf/cat piped into a shell,
//   - ssh's remote command (marked remote, with the host), docker|podman|kubectl exec's command,
//   - $(…) and `…` anywhere outside single quotes, double-quoted ones included.
// Each payload is read again the same way, three levels deep at most. What cannot be read statically (an encoded
// PowerShell command, base64 decoded into a shell, nesting past the cap) marks the command opaque.
import { MAX_SHELL_DEPTH, POWERSHELLS, SHELLS, WRAPPER_OPTIONS, WRAPPERS, } from "./constants.mjs";
export { WRAPPER_OPTIONS, WRAPPERS };
const KEYWORD_NEXT = new Set(["{", "!", "if", "while", "until"]);
// ssh options that take a value (OpenSSH): everything else is a flag.
const SSH_VALUE = new Set([
    "-b",
    "-c",
    "-D",
    "-E",
    "-e",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
    "-B",
]);
const EXEC_VALUE = new Set([
    "-e",
    "--env",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--env-file",
    "-c",
    "--container",
    "-n",
    "--namespace",
    "--detach-keys",
]);
const DECODERS = /^(?:base64|gbase64|openssl|xxd|uudecode)$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const basename = (w) => w.replace(/^.*[\\/]/, "").toLowerCase();
const ESCAPE_CHARS = {
    n: "\n",
    t: "\t",
    r: "\r",
    a: "\x07",
    b: "\b",
    e: "\x1b",
    f: "\f",
    v: "\v",
};
// ANSI-C quoting ($'…'): the common escapes.
function ansiC(s) {
    return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, e) => {
        if (e.startsWith("x"))
            return String.fromCharCode(parseInt(e.slice(1), 16));
        if (/^[0-7]/.test(e))
            return String.fromCharCode(parseInt(e, 8));
        return ESCAPE_CHARS[e] ?? e;
    });
}
// The index just past the `)` closing a `$(` or `(` that opens at `i` (src[i] is the first char inside), quotes and
// nesting respected. src.length when unbalanced.
function closeParen(src, i) {
    let depth = 1;
    let heredocs = [];
    while (i < src.length) {
        const c = src[i];
        const doc = c === "<" ? /^<<(-?)\s*(['"]?)(\w+)\2/.exec(src.slice(i)) : null;
        if (doc?.[3] && src[i + 2] !== "<") {
            heredocs.push({ delim: doc[3], strip: doc[1] === "-" });
            i += doc[0].length;
        }
        else if (c === "\n" && heredocs.length) {
            i++;
            for (const h of heredocs) {
                while (i < src.length) {
                    const nl = src.indexOf("\n", i);
                    const line = src.slice(i, nl < 0 ? src.length : nl);
                    i = nl < 0 ? src.length : nl + 1;
                    if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim)
                        break;
                }
            }
            heredocs = [];
        }
        else if (c === "\\")
            i += 2;
        else if (c === "'")
            i = src.indexOf("'", i + 1) + 1 || src.length + 1;
        else if (c === '"')
            i = closeDouble(src, i + 1);
        else if (c === "`")
            i = src.indexOf("`", i + 1) + 1 || src.length + 1;
        else if (c === "(") {
            depth++;
            i++;
        }
        else if (c === ")") {
            if (--depth === 0)
                return i + 1;
            i++;
        }
        else
            i++;
    }
    return src.length;
}
// The index just past the `"` closing a double-quoted string whose content starts at `i`.
function closeDouble(src, i) {
    while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\")
            i += 2;
        else if (src.startsWith("$(", i) && !src.startsWith("$((", i))
            i = closeParen(src, i + 2);
        else if (src[i] === "`")
            i = src.indexOf("`", i + 1) + 1 || src.length;
        else
            i++;
    }
    return i + 1;
}
const OPS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n", "(", ")"];
/** Scan `src` into simple commands with quoted strings blanked, heredocs captured, and comments removed. */
export function scan(src) {
    const commands = [];
    const current = { command: null };
    let sep = "";
    const pending = [];
    const start = (i) => {
        current.command ??= {
            start: i,
            end: i,
            raw: "",
            code: "",
            words: [],
            heredocs: [],
            redirs: [],
            payloads: [],
            sep,
        };
        return current.command;
    };
    const finish = () => {
        if (current.command &&
            (current.command.words.length || current.command.code.trim()))
            commands.push(current.command);
        current.command = null;
    };
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i] ?? "";
        if (c === " " || c === "\t" || c === "\r") {
            if (current.command)
                current.command.code += c;
            i++;
            continue;
        }
        if (c === "\\" && src[i + 1] === "\n") {
            i += 2;
            continue;
        }
        if (c === "#" && (i === 0 || /[ \t\r\n;&|()]/.test(src[i - 1] ?? ""))) {
            while (i < n && src[i] !== "\n")
                i++;
            continue;
        }
        const op = !src.startsWith("&>", i)
            ? OPS.find((o) => src.startsWith(o, i))
            : undefined;
        // A `(` right after `=`, `@`, `?`, `*`, `+` or `!` belongs to the word before it: a bash array (`x=(a b)`), an
        // extglob (`@(a|b)`) or zsh's `=(cmd)`, whose body is a command. Read past the group: stopping at it looped forever.
        if (op === "(" &&
            current.command &&
            /[=@?*+!]$/.test(current.command.code)) {
            const end = closeParen(src, i + 1);
            const text = src.slice(i, end);
            const w = current.command.words.at(-1);
            if (w) {
                if (w.val === "=")
                    w.substs.push({
                        text: src.slice(i + 1, end - (src[end - 1] === ")" ? 1 : 0)),
                        quoted: false,
                    });
                w.val += text;
                w.raw += text;
            }
            current.command.code += text;
            i = end;
            continue;
        }
        if (op) {
            if (current.command)
                current.command.end = i;
            // A newline right after `&&`, `||`, a pipe or `&` continues the line: the operator stays the separator.
            const continued = op === "\n" &&
                !current.command &&
                ["&&", "||", "|", "|&", "&"].includes(sep);
            finish();
            if (!continued)
                sep = op;
            i += op.length;
            if (op === "\n" && pending.length)
                i = readHeredocs(src, i, pending);
            continue;
        }
        const active = start(i);
        // A redirection: `<<`/`<<-` opens a heredoc; `<<<`, `>`, `>>`, `<`, `>&`, `&>`, `2>` take one word.
        const redir = /^[<>]\(/.test(src.slice(i, i + 2))
            ? null
            : /^(\d*)(<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||>|<)/.exec(src.slice(i));
        if (redir?.[2]) {
            const opText = redir[2];
            i += redir[0].length;
            while (src[i] === " " || src[i] === "\t")
                i++;
            const target = readWord(src, i);
            i = target.end;
            if (opText === "<<" || opText === "<<-") {
                pending.push({
                    delim: target.word.val,
                    strip: opText === "<<-",
                    cmd: active,
                });
                active.code += ` ${redir[0]}${target.word.val} `;
            }
            else {
                active.code += ` ${redir[0]}${target.code} `;
                // An output redirection's file (`>&2`, `>&-` duplicate a descriptor): what the command writes besides its arguments.
                if (opText.includes(">") &&
                    !(opText === ">&" && /^(?:\d+|-)$/.test(target.word.val)))
                    active.redirs.push(target.word);
            }
            continue;
        }
        const { word, code, end } = readWord(src, i);
        active.words.push(word);
        active.code += code;
        i = end;
    }
    if (current.command)
        current.command.end = n;
    finish();
    for (const cmd of commands)
        cmd.raw = src.slice(cmd.start, cmd.end).trim();
    return commands;
}
// Heredoc bodies after the newline at `i`, in order; returns the index after the last delimiter line.
function readHeredocs(src, i, pending) {
    for (const h of pending.splice(0)) {
        const lines = [];
        while (i < src.length) {
            const nl = src.indexOf("\n", i);
            const line = src.slice(i, nl < 0 ? src.length : nl);
            i = nl < 0 ? src.length : nl + 1;
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim)
                break;
            lines.push(h.strip ? line.replace(/^\t+/, "") : line);
        }
        h.cmd.heredocs.push(lines.join("\n"));
    }
    return i;
}
// One word from `i`: its value (quotes removed, escapes applied), its code (quoted parts as ""), the command
// substitutions in it, and where it ends.
function readWord(src, i) {
    const word = { val: "", raw: "", substs: [], quoted: false };
    let code = "";
    const begin = i;
    while (i < src.length) {
        const c = src[i] ?? "";
        // Only a blank (space, tab; CR for CRLF lines), a newline or an operator ends a word, as in the shell: a vertical
        // tab, form feed or Unicode space is part of the word. Ending a word on one the scan loop does not skip looped forever.
        if (/[ \t\r\n;&|()<>]/.test(c)) {
            // `<(…)`/`>(…)` process substitution and `=(` (zsh) are part of the word.
            if ((c === "<" || c === ">") && src[i + 1] === "(") {
                const end = closeParen(src, i + 2);
                word.substs.push({
                    text: src.slice(i + 2, end - 1),
                    quoted: false,
                });
                word.val += src.slice(i, end);
                code += src.slice(i, end);
                i = end;
                continue;
            }
            break;
        }
        if (c === "\\") {
            if (src[i + 1] === "\n") {
                i += 2;
                continue;
            }
            word.val += src[i + 1] ?? "";
            code += src.slice(i, i + 2);
            i += 2;
        }
        else if (c === "'") {
            const end = src.indexOf("'", i + 1);
            const stop = end < 0 ? src.length : end;
            word.val += src.slice(i + 1, stop);
            word.quoted = true;
            code += '""';
            i = stop + 1;
        }
        else if (c === "$" && src[i + 1] === "'") {
            let j = i + 2;
            while (j < src.length && src[j] !== "'")
                j += src[j] === "\\" ? 2 : 1;
            word.val += ansiC(src.slice(i + 2, j));
            word.quoted = true;
            code += '""';
            i = j + 1;
        }
        else if (c === '"') {
            const end = closeDouble(src, i + 1);
            const inner = src.slice(i + 1, end - 1);
            word.val += inner.replace(/\\([$`"\\\n])/g, "$1");
            word.quoted = true;
            for (const s of substitutions(inner))
                word.substs.push({ text: s, quoted: true });
            code += '""';
            i = end;
        }
        else if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
            const end = closeParen(src, i + 2);
            const inner = src.slice(i + 2, end - 1);
            word.substs.push({ text: inner, quoted: false });
            word.val += src.slice(i, end);
            code += `$(${codeOf(inner)})`;
            i = end;
        }
        else if (c === "`") {
            const end = src.indexOf("`", i + 1);
            const stop = end < 0 ? src.length : end;
            word.substs.push({
                text: src.slice(i + 1, stop),
                quoted: false,
            });
            word.val += src.slice(i, stop + 1);
            code += `\`${codeOf(src.slice(i + 1, stop))}\``;
            i = stop + 1;
        }
        else if (c === "$" && src[i + 1] === "(") {
            const end = closeParen(src, i + 2);
            word.val += src.slice(i, end);
            code += src.slice(i, end);
            i = end;
        }
        else if (c === "$" && src[i + 1] === "{") {
            const end = src.indexOf("}", i);
            const stop = end < 0 ? src.length : end + 1;
            word.val += src.slice(i, stop);
            code += src.slice(i, stop);
            i = stop;
        }
        else {
            word.val += c;
            code += c;
            i++;
        }
    }
    word.raw = src.slice(begin, i);
    return { word, code, end: i };
}
// The $(…) and `…` substitutions inside a double-quoted string's content.
function substitutions(inner) {
    const out = [];
    let i = 0;
    while (i < inner.length) {
        if (inner[i] === "\\")
            i += 2;
        else if (inner.startsWith("$(", i) && !inner.startsWith("$((", i)) {
            const end = closeParen(inner, i + 2);
            out.push(inner.slice(i + 2, end - 1));
            i = end;
        }
        else if (inner[i] === "`") {
            const end = inner.indexOf("`", i + 1);
            const stop = end < 0 ? inner.length : end;
            out.push(inner.slice(i + 1, stop));
            i = stop + 1;
        }
        else
            i++;
    }
    return out;
}
/** Return the executable code of a shell fragment (quoted text as `""`, heredocs and comments dropped). */
export const codeOf = (src) => scan(src)
    .map((c) => `${c.sep && c.sep !== "\n" ? `${c.sep} ` : ""}${c.code.trim()}`)
    .join(" ")
    .trim();
// One long option of a wrapper (`--name`, `--name=value`, or a unique prefix of a name): { name, words, value }, or
// null when the wrapper has no such option.
function longOption(spec, words, k) {
    const word = words[k];
    if (!word)
        return null;
    const v = word.val;
    const eq = v.indexOf("=");
    const given = v.slice(2, eq < 0 ? v.length : eq);
    let name = Object.hasOwn(spec.long, given) ? given : null;
    if (name === null) {
        const found = Object.keys(spec.long).filter((n) => n.startsWith(given));
        if (!given || found.length !== 1)
            return null;
        name = found[0] ?? null;
    }
    if (name === null)
        return null;
    if (eq >= 0)
        return {
            name,
            words: 1,
            value: { ...word, val: v.slice(eq + 1), raw: word.raw },
        };
    return spec.long[name]
        ? { name, words: 2, value: words[k + 1] }
        : { name, words: 1 };
}
// One cluster of short options (`-nE`, `-Eu root`, `-oL`): { words, letters, opt, value } where `opt` is the letter that
// took a value, glued or the next word; `unsure` when a letter is not one of the wrapper's options.
function shortOptions(spec, words, k) {
    const word = words[k];
    const v = word?.val ?? "";
    const letters = [];
    for (let i = 1; i < v.length; i++) {
        const c = v[i] ?? "";
        letters.push(c);
        if (spec.value.includes(c)) {
            if (i + 1 < v.length && word)
                return {
                    words: 1,
                    letters,
                    opt: c,
                    value: { ...word, val: v.slice(i + 1) },
                };
            return { words: 2, letters, opt: c, value: words[k + 1] };
        }
        if (spec.optional.includes(c))
            return { words: 1, letters };
        if (!spec.flag.includes(c))
            return { words: 1, letters, unsure: true };
    }
    return { words: 1, letters };
}
/** Unwrap prefix assignments and wrapper commands (`sudo`, `env`, `timeout`, ...) from `words`. */
export function wrapped(words) {
    let k = 0;
    const heads = [];
    let unsure = false;
    while (k < words.length && ASSIGNMENT.test(words[k]?.val ?? ""))
        k++;
    while (k < words.length && WRAPPERS.has(basename(words[k]?.val ?? ""))) {
        const name = basename(words[k]?.val ?? "");
        const spec = WRAPPER_OPTIONS[name];
        if (!spec)
            break;
        heads.push(k++);
        let ended = false;
        let exec = false;
        while (k < words.length) {
            const current = words[k];
            if (!current)
                break;
            const v = current.val;
            if (spec.assign && ASSIGNMENT.test(v) && !(ended && name === "sudo"))
                k++;
            else if (v === "-" &&
                name === "env" &&
                (!ended || words[k - 1]?.val === "--")) {
                // env's lone `-` is -i, also as the first word after `--` (GNU env); anywhere else it is the command.
                k++;
            }
            else if (ended || !v.startsWith("-") || v === "-")
                break;
            else if (v === "--") {
                ended = true;
                k++;
            }
            else if (spec.numeric && /^-[-+]?\d/.test(v))
                k++;
            else {
                const o = v.startsWith("--")
                    ? longOption(spec, words, k)
                    : shortOptions(spec, words, k);
                if (!o || o.unsure) {
                    unsure = true;
                    k++;
                    continue;
                }
                const nextWord = words[k + 1];
                // sudo's `-h` alone is a host when a plain word follows (sudo's own rule), else help.
                if (name === "sudo" &&
                    v === "-h" &&
                    nextWord &&
                    !nextWord.val.startsWith("-") &&
                    !ASSIGNMENT.test(nextWord.val))
                    o.words = 2;
                if (o.name === "exec" || o.letters?.includes("x"))
                    exec = true;
                if (spec.split && (o.name === "split-string" || o.opt === "S")) {
                    // env -S: its value is split into words that run ahead of the rest, options and assignments included.
                    const rest = words.slice(k + o.words);
                    const text = `env ${o.value?.val ?? ""}${rest.length ? ` ${requote(rest.map((w) => w.val))}` : ""}`;
                    return {
                        words: [],
                        heads,
                        payload: { text, words: [o.value ?? current, ...rest] },
                        unsure,
                    };
                }
                k += o.words;
            }
        }
        for (let p = 0; p < spec.pos && k < words.length; p++)
            k++;
        if (spec.priority && /^\d+$/.test(words[k]?.val ?? ""))
            k++;
        // `time` is a shell keyword: a group or a negation may follow it (`time -p { …; }`, `time ! …`), and the command is in it.
        if (spec.keyword)
            while (k < words.length &&
                KEYWORD_NEXT.has(words[k]?.val ?? "") &&
                !words[k]?.quoted)
                k++;
        if (spec.shell && !exec) {
            // watch runs its words joined with spaces through `sh -c`.
            const rest = words.slice(k);
            return {
                words: [],
                heads,
                payload: rest.length
                    ? { text: rest.map((w) => w.val).join(" "), words: rest }
                    : null,
                unsure,
            };
        }
    }
    if (k < words.length)
        heads.push(k);
    return { words: words.slice(k), heads, payload: null, unsure };
}
/** Return the words of a simple command after prefix assignments and wrappers (`sudo`, `env`, `xargs`, ...). */
export const commandWords = (words) => wrapped(words).words;
// Re-quotes argv words as one command line: a word with anything a shell would split or expand is single-quoted.
const requote = (words) => words
    .map((w) => /^[\w./@%+=:,~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)
    .join(" ");
const escapes = (text) => /\\[$`]/.test(text) ? "escaped" : true;
const expands = (ws) => {
    const outside = ws.map((w) => w.raw.replace(/'[^']*'/g, "")).join(" ");
    return /[$`]/.test(outside) ? escapes(outside) : false;
};
function payloadsOf(cmd, prev) {
    const out = [];
    let opaque = false;
    // Substitutions run first, in this shell. One that is the whole value of an assignment, double-quoted
    // (`TOKEN="$(keyring read)" ./deploy`), injects a value into an environment, never into output.
    for (const w of cmd.words) {
        const injected = /^[A-Za-z_]\w*="\$\([\s\S]*\)"$/.test(w.raw) && w.substs.length === 1;
        for (const s of w.substs)
            out.push({ kind: "subst", text: s.text, injected });
    }
    const run = wrapped(cmd.words);
    if (run.unsure)
        opaque = true;
    if (run.payload)
        out.push({
            kind: "shell",
            text: run.payload.text,
            expanded: expands(run.payload.words),
        });
    const words = run.words;
    const name = words[0] ? basename(words[0].val) : "";
    const args = words.slice(1);
    if (SHELLS.has(name)) {
        let c = false;
        let k = 0;
        for (; k < args.length; k++) {
            const a = args[k]?.val ?? "";
            if (a === "--") {
                k++;
                break;
            }
            if (!/^[-+]/.test(a))
                break;
            if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
                c = true;
            if (/^[-+]o$|^[-+]O$|^--(?:rcfile|init-file)$/.test(a))
                k++;
        }
        const targetArg = args[k];
        if (c && targetArg)
            out.push({
                kind: "shell",
                text: targetArg.val,
                expanded: expands([targetArg]),
            });
        else if (!c && !args.slice(k).length) {
            for (const body of cmd.heredocs)
                out.push({ kind: "shell", text: body, expanded: escapes(body) });
            if (prev) {
                const from = commandWords(prev.words);
                const fromName = from[0] ? basename(from[0].val) : "";
                if (prev.decoder)
                    opaque = true;
                else if (fromName === "echo")
                    out.push({
                        kind: "shell",
                        text: from
                            .slice(1)
                            .filter((w) => !/^-[neE]+$/.test(w.val))
                            .map((w) => w.val)
                            .join(" "),
                        expanded: escapes(from.map((w) => w.raw).join(" ")),
                    });
                else if (fromName === "printf")
                    out.push({
                        kind: "shell",
                        text: ansiC(from[1]?.val ?? ""),
                        expanded: escapes(from[1]?.raw ?? ""),
                    });
                else if (fromName === "cat" && prev.heredocs.length)
                    for (const body of prev.heredocs)
                        out.push({
                            kind: "shell",
                            text: body,
                            expanded: escapes(body),
                        });
            }
        }
    }
    else if (name === "eval") {
        out.push({
            kind: "shell",
            text: args.map((w) => w.val).join(" "),
            expanded: expands(args),
        });
    }
    else if (POWERSHELLS.has(name)) {
        const k = args.findIndex((w) => /^-(?:c|command)$/i.test(w.val));
        if (args.some((w) => /^-(?:e|ec|enc|encodedcommand)$/i.test(w.val)))
            opaque = true;
        else if (k >= 0)
            out.push({
                kind: "shell",
                text: args
                    .slice(k + 1)
                    .map((w) => w.val)
                    .join(" "),
                expanded: true,
            });
    }
    else if (name === "cmd" || name === "cmd.exe") {
        const k = args.findIndex((w) => /^\/[ck]$/i.test(w.val));
        if (k >= 0)
            out.push({
                kind: "shell",
                text: args
                    .slice(k + 1)
                    .map((w) => w.val)
                    .join(" "),
                expanded: true,
            });
    }
    else if (name === "ssh") {
        let k = 0;
        while (k < args.length && (args[k]?.val.startsWith("-") ?? false))
            k += SSH_VALUE.has(args[k]?.val ?? "") ? 2 : 1;
        const host = args[k]?.val;
        const rest = args
            .slice(k + 1)
            .map((w) => w.val)
            .join(" ");
        if (host && rest)
            out.push({
                kind: "ssh",
                text: rest,
                remote: true,
                host: host.replace(/^.*@/, ""),
                expanded: expands(args.slice(k + 1)),
            });
        else if (host)
            for (const body of cmd.heredocs)
                out.push({
                    kind: "ssh",
                    text: body,
                    remote: true,
                    host: host.replace(/^.*@/, ""),
                    expanded: escapes(body),
                });
    }
    else if (["docker", "podman", "nerdctl", "kubectl", "oc"].includes(name)) {
        let k = args.findIndex((w) => w.val === "exec");
        if (k >= 0) {
            if (name === "kubectl" || name === "oc") {
                const dash = args.findIndex((w) => w.val === "--");
                k = dash;
            }
            else {
                k++;
                while (k < args.length && (args[k]?.val.startsWith("-") ?? false))
                    k += EXEC_VALUE.has(args[k]?.val ?? "") ? 2 : 1;
            }
            // The container's files are not this machine's: judged like a remote host.
            const container = name === "kubectl" || name === "oc"
                ? args
                    .slice(args.findIndex((w) => w.val === "exec") + 1)
                    .find((w) => !w.val.startsWith("-"))?.val
                : args[k]?.val;
            if (k >= 0 && args[k + 1])
                out.push({
                    kind: "exec",
                    text: requote(args.slice(k + 1).map((w) => w.val)),
                    remote: true,
                    host: `${name}:${container ?? ""}`,
                    expanded: expands(args.slice(k + 1)),
                });
        }
    }
    return { payloads: out, opaque };
}
/** Analyze a shell command recursively up to `MAX_SHELL_DEPTH` payload levels. */
export function analyze(src, depth = 0) {
    const commands = scan(src);
    let opaque = false;
    commands.forEach((cmd, i) => {
        const prev = cmd.sep === "|" || cmd.sep === "|&" ? commands[i - 1] : null;
        const name = commandWords(cmd.words)[0]?.val ?? "";
        const args = commandWords(cmd.words)
            .slice(1)
            .map((w) => w.val);
        // A decoder in a pipeline: what it decodes cannot be read, so a shell it feeds is opaque.
        cmd.decoder =
            (prev?.decoder ?? false) ||
                (DECODERS.test(basename(name)) &&
                    args.some((a) => /^(?:-d|--decode|-D|-r|-base64)$/.test(a)));
        const found = payloadsOf(cmd, prev);
        if (found.opaque)
            opaque = true;
        cmd.payloads = found.payloads.map((p) => {
            if (depth + 1 > MAX_SHELL_DEPTH) {
                opaque = true;
                return { ...p, analysis: { commands: [], opaque: true } };
            }
            const analysis = analyze(p.text, depth + 1);
            if (analysis.opaque)
                opaque = true;
            return { ...p, analysis };
        });
    });
    return { commands, opaque };
}
/** Return every simple command in an analysis, payloads included, depth-first in order. */
export function units(analysis, ctx = {
    remote: false,
    host: undefined,
    injected: false,
    depth: 0,
}) {
    const out = [];
    const siblings = analysis.commands.filter((c) => !/^(?:do|done|then|fi|else|esac|\{|\})?$/.test(c.code.trim())).length;
    for (const cmd of analysis.commands) {
        out.push({ cmd, ...ctx, siblings });
        for (const p of cmd.payloads) {
            out.push(...units(p.analysis, {
                remote: ctx.remote || Boolean(p.remote),
                host: p.host ?? ctx.host,
                injected: ctx.injected || Boolean(p.injected),
                depth: ctx.depth + 1,
                kind: p.kind,
            }));
        }
    }
    return out;
}
