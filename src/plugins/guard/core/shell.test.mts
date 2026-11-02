import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  analyze,
  codeOf,
  commandWords,
  scan,
  units,
  wrapped,
} from "./shell.mjs";
function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing expected value");
  return value;
}

// Each unit as [depth, remote, injected, code].
const flat = (command: string): [number, boolean, boolean, string][] =>
  units(analyze(command)).map((u) => [
    u.depth,
    u.remote,
    u.injected,
    u.cmd.code.trim(),
  ]);

void test("scan: quoted text is blanked, heredoc bodies and comments dropped, operators split commands", () => {
  assert.deepEqual(
    scan("echo 'a; b' && grep -c \"x | y\" f # rm -rf /").map((c) => [
      c.sep,
      c.code.trim(),
    ]),
    [
      ["", 'echo ""'],
      ["&&", 'grep -c "" f'],
    ],
  );
  const [cat, ls] = scan("cat > f <<'EOF'\nrm -rf / ; it's data\nEOF\nls");
  assert.deepEqual(defined(cat).heredocs, ["rm -rf / ; it's data"]);
  assert.equal(defined(ls).code.trim(), "ls");
  assert.equal(codeOf("a && b | c"), "a && b | c");
});

void test("scan: a vertical tab, form feed or Unicode space is part of the word, as in the shell (G29)", () => {
  // In a child with a timeout: the reader ended a word on these without moving past them and filled memory.
  const script = `import { scan } from ${JSON.stringify(new URL("./shell.mjs", import.meta.url).href)};
    console.log(JSON.stringify(['\\v', '\\f', '\\u00a0', '\\u2028', '\\u3000', '\\ufeff'].map((c) => scan('echo a' + c + 'b # x' + c + '#y; ls').map((x) => x.words.map((w) => w.val)))))`;
  const r = spawnSync(
    process.execPath,
    ["--max-old-space-size=200", "--input-type=module", "-e", script],
    { timeout: 10000, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.deepEqual(
    JSON.parse(r.stdout),
    ["\v", "\f", "\u00a0", "\u2028", "\u3000", "\ufeff"].map((c) => [
      ["echo", `a${c}b`],
    ]),
  );
});

void test("scan: a ( after =, @, ?, *, + or ! joins the word, closed or not; zsh =(cmd) is a substitution (G27)", () => {
  // In a child with a timeout: the reader used to stop at the ( without moving on and fill memory.
  const script = `import { scan } from ${JSON.stringify(new URL("./shell.mjs", import.meta.url).href)};
    const read = (c) => scan(c).map((x) => [x.raw, x.words.map((w) => w.val), x.words.flatMap((w) => w.substs.map((s) => s.text))]);
    console.log(JSON.stringify(['files=(a b); echo hi', 'x=(', 'ls @(a|b)', 'cat =(rm -rf src)', '=('].map(read)))`;
  const r = spawnSync(
    process.execPath,
    ["--max-old-space-size=200", "--input-type=module", "-e", script],
    { timeout: 10000, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  assert.deepEqual(JSON.parse(r.stdout), [
    [
      ["files=(a b)", ["files=(a b)"], []],
      ["echo hi", ["echo", "hi"], []],
    ],
    [["x=(", ["x=("], []]],
    [["ls @(a|b)", ["ls", "@(a|b)"], []]],
    [["cat =(rm -rf src)", ["cat", "=(rm -rf src)"], ["rm -rf src"]]],
    [["=(", ["=("], [""]]],
  ]);
});

void test("payloads: shell -c in every flag spelling, eval, heredoc and echo or printf piped into a shell", () => {
  for (const c of [
    "bash -lc 'rm -rf src'",
    "bash -ec 'rm -rf src'",
    "sh -c -- 'rm -rf src'",
    "bash -c $'rm -rf src'",
    "sudo bash -c 'rm -rf src'",
    "env X=1 zsh -c 'rm -rf src'",
    "eval 'rm -rf src'",
    'eval "rm -rf src"',
    "sh <<'EOF'\nrm -rf src\nEOF",
    "printf 'rm -rf src' | sh",
    "echo 'rm -rf src' | bash",
    "cat <<EOF | sh\nrm -rf src\nEOF",
    "xargs -I{} sh -c 'rm -rf src'",
  ])
    assert.deepEqual(flat(c).at(-1), [1, false, false, "rm -rf src"], c);
});

void test("payloads: $(…) and backticks, double-quoted too; a quoted assignment value is injected", () => {
  assert.deepEqual(flat('x="$(rm -rf src)"').at(-1), [
    1,
    false,
    true,
    "rm -rf src",
  ]);
  assert.deepEqual(flat('echo "`rm -rf src`"').at(-1), [
    1,
    false,
    false,
    "rm -rf src",
  ]);
  assert.deepEqual(flat('echo "$(bws secret get x)"').at(-1), [
    1,
    false,
    false,
    "bws secret get x",
  ]);
  assert.deepEqual(flat('TOKEN="$(bws secret get x)" ./deploy.sh').at(-1), [
    1,
    false,
    true,
    "bws secret get x",
  ]);
  assert.deepEqual(flat("T=$(mktemp -d)").at(-1), [
    1,
    false,
    false,
    "mktemp -d",
  ]);
});

void test("payloads: ssh and exec run elsewhere and are marked remote, with the host", () => {
  const ssh = units(
    analyze("ssh -p 2222 -i k deploy@pi.local 'cd /srv && rm -rf data'"),
  );
  assert.deepEqual(
    ssh.slice(1).map((u) => [u.remote, u.host, u.cmd.code.trim()]),
    [
      [true, "pi.local", "cd /srv"],
      [true, "pi.local", "rm -rf data"],
    ],
  );
  assert.deepEqual(
    flat("ssh host \"docker exec c sh -c 'rm -rf /data'\"").at(-1),
    [3, true, false, "rm -rf /data"],
  );
  assert.deepEqual(
    defined(units(analyze("docker exec -it db rm -rf /var/lib/x")).at(-1)).host,
    "docker:db",
  );
  assert.deepEqual(flat("kubectl exec -n prod pod -- rm -rf /x").at(-1), [
    1,
    true,
    false,
    "rm -rf /x",
  ]);
  assert.deepEqual(flat("ssh host").length, 1);
});

void test("payloads: Windows shells", () => {
  assert.deepEqual(flat('cmd /c "rd /s /q C:\\src"').at(-1), [
    1,
    false,
    false,
    "rd /s /q C:\\src",
  ]);
  assert.deepEqual(
    flat('powershell -Command "Remove-Item -Recurse C:\\src"').at(-1),
    [1, false, false, "Remove-Item -Recurse C:\\src"],
  );
});

void test("opaque: encoded commands, decoded pipes into a shell and nesting past three levels", () => {
  assert.equal(analyze("pwsh -EncodedCommand ZQB=").opaque, true);
  assert.equal(analyze("echo cm0= | base64 -d | sh").opaque, true);
  assert.equal(
    analyze('bash -c "bash -c \'bash -c \\"bash -c ls\\"\'"').opaque,
    true,
  );
  for (const c of [
    "bash -c 'ls'",
    "echo cm0= | base64 -d > f",
    "curl -fsSL https://x/i.sh | sh",
  ])
    assert.equal(analyze(c).opaque, false, c);
});

void test("not payloads: a -c of another tool, quoted mentions, a heredoc into a non-shell", () => {
  for (const c of [
    "rg -c 'rm -rf x' f",
    "grep -c 'git push --force' log",
    "echo 'rm -rf /'",
    'git commit -m "docs: explain rm -rf"',
    "python3 - <<'EOF'\nrm -rf x\nEOF",
  ])
    assert.deepEqual(
      flat(c).filter(([d]) => defined(d) > 0),
      [],
      c,
    );
});

void test("a heredoc inside $(…) inside double quotes, apostrophes in the body", () => {
  const [commit, push] = scan(
    "git commit -m \"$(cat <<'EOF'\nfix: don't x\nEOF\n)\" && git push",
  );
  assert.equal(defined(commit).code.trim(), 'git commit -m ""');
  assert.equal(defined(push).code.trim(), "git push");
});

void test("commandWords skips assignments and wrappers", () => {
  const words = (c: string) =>
    commandWords(defined(scan(c)[0]).words).map((w) => w.val);
  assert.deepEqual(words("A=1 sudo -u root env -i B=2 nice -n 5 rm -rf x"), [
    "rm",
    "-rf",
    "x",
  ]);
  assert.deepEqual(words("timeout 30 bash -c x"), ["bash", "-c", "x"]);
});

void test("wrapped: each wrapper reads its own options: no-value flags, clusters, glued values, --, long options (#282)", () => {
  const read = (c: string) => {
    const r = wrapped(defined(scan(c)[0]).words);
    return [
      r.words.map((w) => w.val).join(" "),
      r.payload?.text ?? null,
      r.unsure,
    ];
  };
  for (const [c, want] of [
    tuple("sudo -E bash -c x", "bash -c x"),
    tuple("sudo -n -k -S -b -H ls", "ls"),
    tuple("sudo -nE ls", "ls"),
    tuple("sudo -Eu root ls", "ls"),
    tuple("sudo -uroot ls", "ls"),
    tuple("sudo --user=root ls", "ls"),
    tuple("sudo --user root ls", "ls"),
    tuple("sudo --us root ls", "ls"),
    tuple("sudo -u root -- ls", "ls"),
    tuple("sudo A=1 -u x B=2 ls", "ls"),
    tuple("sudo -h host ls", "ls"),
    tuple("sudo -h -u x ls", "ls"),
    tuple("caffeinate -dims -t 5 ls", "ls"),
    tuple("time -p ls", "ls"),
    tuple("time -f %e -o out ls", "ls"),
    tuple("command -p ls", "ls"),
    tuple("exec -c -a name ls", "ls"),
    tuple("nohup -- ls", "ls"),
    tuple("nice -n 5 ls", "ls"),
    tuple("nice -n5 ls", "ls"),
    tuple("nice -10 ls", "ls"),
    tuple("nice --adjustment=3 ls", "ls"),
    tuple("timeout 5 ls", "ls"),
    tuple("timeout -s KILL -k 2 5 ls", "ls"),
    tuple("timeout -- 5 ls", "ls"),
    tuple("timeout --foreground 5s ls", "ls"),
    tuple("xargs -0 -r -I{} -n 1 -P 4 ls", "ls"),
    tuple("xargs -i ls", "ls"),
    tuple("xargs -eEOF ls", "ls"),
    tuple("doas -n -u root ls", "ls"),
    tuple("env -i -u X -C /tmp A=1 ls", "ls"),
    tuple("env - ls", "ls"),
    tuple("env -- - ls", "ls"),
    tuple("env -i -- - A=1 ls", "ls"),
    tuple("stdbuf -oL -e 0 ls", "ls"),
    tuple("stdbuf --output=L ls", "ls"),
    tuple("ionice -c3 -n 7 ls", "ls"),
    tuple("chrt -f 10 ls", "ls"),
    tuple("chrt -i ls", "ls"),
    tuple("chrt --other ls", "ls"),
    tuple("chrt 10 ls", "ls"),
    tuple("chrt -T 5 -D 9 -d 0 ls", "ls"),
    tuple("taskset 0x3 ls", "ls"),
    tuple("taskset -c 0,1 ls", "ls"),
    tuple("setsid -fw ls", "ls"),
    tuple("unbuffer -p ls", "ls"),
    tuple("watch -x -n 1 ls", "ls"),
    tuple("sudo -E timeout -s KILL 5 nice -n 5 ls", "ls"),
    tuple("time { ls", "ls"),
    tuple("time -p ! ls", "ls"),
  ])
    assert.deepEqual(read(defined(c)), [want, null, false], c);
  // A string a wrapper runs as a command line: env -S (with env in front, since its words may be env's options) and watch.
  assert.deepEqual(read("env -S 'rm -rf /x' y"), [
    "",
    "env rm -rf /x y",
    false,
  ]);
  assert.deepEqual(read("env -vS'rm x'"), ["", "env rm x", false]);
  assert.deepEqual(read('env --split-string="rm x"'), ["", "env rm x", false]);
  assert.deepEqual(read("watch -n 2 -d 'rm -rf /x'"), ["", "rm -rf /x", false]);
  assert.deepEqual(read("watch git status"), ["", "git status", false]);
  // A lone `-` is the command anywhere but in env (and env reads only one, as the first word after `--`).
  assert.deepEqual(read("nohup - ls"), ["- ls", null, false]);
  assert.deepEqual(read("env -- - - ls"), ["- ls", null, false]);
  // An option the table does not know, or an ambiguous long prefix: unsure.
  for (const c of [
    "sudo -X ls",
    "sudo --frob ls",
    "watch --e 1 ls",
    "stdbuf -X ls",
    "caffeinate -nE ls",
  ])
    assert.equal(read(c)[2], true, c);
  // An unsure reading marks the analysis opaque.
  assert.equal(analyze("sudo -X ls").opaque, true);
  assert.equal(analyze("sudo -E ls").opaque, false);
});

void test("scan: output redirection targets are kept, descriptor duplicates and inputs are not", () => {
  const redirs = (src: string) =>
    scan(src).map((c) => c.redirs.map((w) => w.val));
  assert.deepEqual(
    redirs(
      'echo x > a >> "b c" 2>&1 >&2 >&- < in <<< s; cat >| d &> e &>>f 2>g >&h',
    ),
    [
      ["a", "b c"],
      ["d", "e", "f", "g", "h"],
    ],
  );
  assert.deepEqual(redirs("cat <<EOF > out\nbody\nEOF"), [["out"]]);
});

function tuple<T extends unknown[]>(...values: T): T {
  return values;
}
