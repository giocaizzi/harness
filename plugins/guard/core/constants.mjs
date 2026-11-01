export const UNIX_PROBES = {
    load: ["uptime"],
    disk: ["df", "-k", "/"],
};
// Windows: one PowerShell call printing "<cpu percent> <free bytes of the system drive>".
export const WINDOWS_PROBE = [
    "powershell",
    "-NoProfile",
    "-Command",
    "$c=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; " +
        '$f=(Get-PSDrive -Name ($env:SystemDrive.TrimEnd(":"))).Free; "$c $f"',
];
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
`;
export const OTEL_TIMEOUT_MS = 2000;
export const MAX_SHELL_DEPTH = 3;
export const SHELLS = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "mksh",
    "ash",
    "fish",
    "busybox",
]);
export const POWERSHELLS = new Set([
    "pwsh",
    "powershell",
    "pwsh.exe",
    "powershell.exe",
]);
const wrapperSpec = (value, flag, long = {}, extra = {}) => ({
    value,
    flag,
    optional: "",
    long,
    pos: 0,
    ...extra,
});
const flags = (names) => Object.fromEntries(names
    .split(" ")
    .filter(Boolean)
    .map((n) => [n, false]));
const values = (names) => Object.fromEntries(names
    .split(" ")
    .filter(Boolean)
    .map((n) => [n, true]));
const COMMON = flags("help version");
export const WRAPPER_OPTIONS = {
    sudo: wrapperSpec("aCcDgpRrTtUu", "ABbEeHhiKklNnPSsVv", {
        ...COMMON,
        ...values("auth-type close-from login-class chdir group host prompt chroot role command-timeout type user other-user"),
        ...flags("background preserve-env edit set-home login remove-timestamp list preserve-groups shell validate askpass bell reset-timestamp no-update non-interactive stdin"),
    }, { assign: true }),
    doas: wrapperSpec("aCu", "Lns"),
    env: wrapperSpec("aCLPSUu", "0iv", {
        ...COMMON,
        ...values("argv0 env0-from unset chdir quoting-style split-string"),
        ...flags("ignore-environment null default-signal ignore-signal block-signal list-signal-handling debug"),
    }, { assign: true, split: true }),
    command: wrapperSpec("", "pVv"),
    exec: wrapperSpec("a", "cl"),
    nohup: wrapperSpec("", "", COMMON),
    time: wrapperSpec("fo", "ahlpqVv", {
        ...COMMON,
        ...values("format output"),
        ...flags("append portability verbose quiet"),
    }, { keyword: true }),
    nice: wrapperSpec("n", "", { ...COMMON, ...values("adjustment") }, { numeric: true }),
    timeout: wrapperSpec("ks", "fpv", {
        ...COMMON,
        ...values("kill-after signal"),
        ...flags("foreground preserve-status verbose"),
    }, { pos: 1 }),
    xargs: wrapperSpec("adEIJLnPRSs", "0oprtx", {
        ...COMMON,
        ...values("arg-file delimiter max-args max-chars max-procs process-slot-var"),
        ...flags("null eof replace max-lines open-tty interactive no-run-if-empty verbose show-limits exit"),
    }, { optional: "eil" }),
    caffeinate: wrapperSpec("tw", "dhimsu"),
    stdbuf: wrapperSpec("eio", "", {
        ...COMMON,
        ...values("input output error"),
    }),
    ionice: wrapperSpec("cnpPu", "htV", {
        ...COMMON,
        ...values("class classdata pid pgid uid"),
        ...flags("ignore"),
    }),
    chrt: wrapperSpec("DPTUX", "abdefGhimOopRrVv", {
        ...COMMON,
        ...values("sched-runtime sched-period sched-deadline clamp-min clamp-max"),
        ...flags("all-tasks batch deadline deadline-overrun ext fifo idle pid max other rr reset-on-fork reclaim-grub verbose"),
    }, { priority: true }),
    taskset: wrapperSpec("", "achpV", { ...COMMON, ...flags("all-tasks pid cpu-list") }, { pos: 1 }),
    setsid: wrapperSpec("", "cfhVw", {
        ...COMMON,
        ...flags("ctty fork wait"),
    }),
    unbuffer: wrapperSpec("", "p"),
    watch: wrapperSpec("nqs", "bCcefghprtvwx", {
        ...COMMON,
        ...values("interval equexit shotsdir"),
        ...flags("color no-color differences beep errexit follow chgexit exec precise no-rerun no-title no-wrap"),
    }, { optional: "d", shell: true }),
};
export const WRAPPERS = new Set(Object.keys(WRAPPER_OPTIONS));
export const OPAQUE = "<guard:opaque>";
export const DEFAULT_PROTECTED_LIMITS = {
    globs: 256,
    targets: 512,
    chars: 1024,
    ms: 2000,
};
