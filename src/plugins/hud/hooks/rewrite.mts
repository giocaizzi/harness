import { KIND, target } from "./links.mjs";
import { ICON } from "./weather.mjs";
import { escapeMd as esc, mark } from "./markup.mjs";
import type {
  Facts,
  ForgeRepoInfo,
  RewriteContext,
  WorkItemReference,
} from "./types.mjs";

export const FEATURES = [
  "replySecrets",
  "replyUrls",
  "replyRefs",
  "replyState",
  "replyPaths",
  "replyFileLinks",
  "replyCommits",
  "replyTimes",
  "replyStatus",
] as const;

export type FeatureName = (typeof FEATURES)[number];

export interface FeatureOptions {
  glyph: boolean;
  colour: boolean;
}

export interface SettingsOutput {
  glyphs: boolean;
  colour: boolean;
  editor: string;
  editorUrl: string;
  timeFormat: string;
  f: Record<FeatureName, FeatureOptions | null>;
  [key: string]: unknown;
}

export const DEFAULTS: Record<string, unknown> = {
  glyphs: true,
  colour: true,
  ...Object.fromEntries(FEATURES.map((f) => [f, "on"])),
  editor: "vscode",
  editorUrl: "",
  timeFormat: "both",
};

export function settings(
  options: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
  canColour = true,
): SettingsOutput {
  const o: Record<string, unknown> = {
    ...DEFAULTS,
    ...Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== undefined && v !== null),
    ),
  };
  const plain = Boolean(env.NO_COLOR);
  const f = {} as Record<FeatureName, FeatureOptions | null>;
  for (const k of FEATURES) {
    const raw = o[k];
    const mode = raw === true ? "on" : raw === false ? "off" : raw;
    f[k] =
      mode === "off"
        ? null
        : {
            glyph:
              !plain &&
              o.glyphs !== false &&
              mode !== "no-glyph" &&
              mode !== "plain",
            colour:
              canColour &&
              !plain &&
              o.colour !== false &&
              mode !== "no-colour" &&
              mode !== "plain",
          };
  }
  return {
    glyphs: o.glyphs !== false,
    colour: o.colour !== false,
    editor: o.editor as string,
    editorUrl: o.editorUrl as string,
    timeFormat: o.timeFormat as string,
    f,
  };
}

export interface GlyphMap {
  dir: string;
  file: string;
  editor: string;
  commit: string;
  lock: string;
  clock: string;
  github: string;
  gitlab: string;
  azure: string;
  globe: string;
  [key: string]: string;
}

export const GLYPH: GlyphMap = {
  dir: "",
  file: "",
  editor: "",
  commit: "",
  lock: "",
  clock: "",
  github: "",
  gitlab: "",
  azure: "",
  globe: "",
};

const EXT: Record<string, string> = {
  ts: "",
  tsx: "",
  js: "",
  mjs: "",
  cjs: "",
  jsx: "",
  py: "",
  md: "",
  json: "",
  sh: "",
  bash: "",
  zsh: "",
  ps1: "",
  go: "",
  rs: "",
  rb: "",
  java: "",
  html: "",
  css: "",
  yml: "",
  yaml: "",
  toml: "",
  sql: "",
  lock: "",
};

export const fileGlyph = (name: string, kind?: string | null): string =>
  kind === "dir"
    ? GLYPH.dir
    : (EXT[/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""] ?? GLYPH.file);

export const STATE: Record<string, Record<string, string>> = {
  issue: { open: "", closed: "", completed: "", not_planned: "" },
  pr: {
    open: ICON.pr ?? "",
    merged: ICON.merged ?? "",
    closed: "",
    draft: "",
  },
  workitem: { open: KIND.workitem.icon, closed: "" },
};

const FENCE = /^ {0,3}(```|~~~)/;
const PROTECT =
  /(`+)[^`]*?\1|\[(?:\\.|[^\]\\\n])*\]\([^)\n]*\)|<[a-z][\w+.-]*:[^>\n]*>|\b[a-z][\w+.-]*:\/\/[^\s)>]+|\uFDD0[^\uFDD2]*\uFDD2/g;
const BORDER = /^\s*[+┌├└╭╰┏┣┗╔╠╚╒╞╘][-─━═=+┬┼┴┐┤┘╮╯┓┫┛╗╣╝╤╪╧┳╋┻╦╬╩ ]*$/;
const BOXED = /^\s*[│┃║]/;

export function kept(text: string): [string, boolean][] {
  const all = text.split("\n");
  const keep = all.map(() => false);
  let fence: string | null = null;
  let start = 0;
  let drawn = false;
  const end = (i: number): void => {
    if (drawn) keep.fill(true, start, i);
    start = i + 1;
    drawn = false;
  };
  all.forEach((l, i) => {
    const f = FENCE.exec(l)?.[1];
    if (fence || f) {
      if (fence && f === fence) fence = null;
      else if (!fence && f) fence = f;
      keep[i] = true;
      end(i);
    } else if (!l.trim()) {
      end(i);
    } else if ((BORDER.test(l) && /[-─━═]{3}/.test(l)) || BOXED.test(l)) {
      drawn = true;
    }
  });
  end(all.length);
  return all.map((l, i) => [l, keep[i] ?? false]);
}

function lines(text: string, fn: (l: string) => string): string {
  return kept(text)
    .map(([l, keep]) => (keep ? l : fn(l)))
    .join("\n");
}

export function pass(
  text: string,
  re: RegExp,
  fn: ((match: string, ...args: string[]) => string) | null,
  span?: (s: string) => string,
): string {
  return lines(text, (line) => {
    let out = "";
    let at = 0;
    for (const m of line.matchAll(PROTECT)) {
      const idx = m.index;
      const slice = line.slice(at, idx);
      out += (fn ? slice.replace(re, fn) : slice) + (span ? span(m[0]) : m[0]);
      at = idx + m[0].length;
    }
    const tail = line.slice(at);
    return out + (fn ? tail.replace(re, fn) : tail);
  });
}

const link = (label: string, url: string): string =>
  `[${label}](${url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
const glyphed = (g: string, ft: FeatureOptions, label: string): string =>
  ft.glyph ? `${g} ${label}` : label;

const SECRET = new RegExp(
  [
    "\\b(gh[pousr]_)[A-Za-z0-9]{20,}",
    "\\b(github_pat_)\\w{20,}",
    "\\b(sk-ant-)(?=[\\w-]*\\d)[\\w-]{16,}",
    "\\b(sk-(?:proj-)?)(?=[\\w-]*\\d)[\\w-]{20,}",
    "\\b(A(?:KIA|SIA))[0-9A-Z]{16}\\b",
    "\\b(xox[abprse]-)[\\w-]{10,}",
    "\\b(Bearer\\s+)(?=[\\w.~+/=-]*\\d)[\\w.~+/=-]{16,}",
  ].join("|"),
  "g",
);
const KEY_BLOCK =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g;
const MASK = "••••••••";

function secrets(text: string, ft: FeatureOptions): string {
  const prefix = (g: unknown[]): string => {
    for (const x of g) {
      if (typeof x === "string") return x;
    }
    return "";
  };
  const styled = pass(
    text,
    SECRET,
    (_all, ...g) =>
      mark("secret", glyphed(GLYPH.lock, ft, prefix(g)), ft.colour) +
      mark("dim", MASK, ft.colour),
  );
  return styled
    .replace(SECRET, (_all, ...g) => prefix(g) + MASK)
    .replace(KEY_BLOCK, `$1\n${MASK}\n$2`);
}

const forgeOfHost = (host: string): string | null =>
  /github/i.test(host)
    ? "github"
    : /gitlab/i.test(host)
      ? "gitlab"
      : /dev\.azure\.com|visualstudio\.com/i.test(host)
        ? "azure"
        : null;

export interface ShortUrlResult {
  label: string;
  kind: string;
  forge: string | null;
}

export function shortUrl(
  href: string,
  here: ForgeRepoInfo | null,
): ShortUrlResult | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const forge = forgeOfHost(u.host);
  const p = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const line = /^#L(\d+)/.exec(u.hash)?.[1];
  const at = (path: string, sha: string): string =>
    `${path.split("/").at(-1) ?? ""}@${sha.slice(0, 7)}`;
  const file = (path: string, rest: string[]): string =>
    `${path.split("/").at(-1) ?? ""} › ${rest.join("/")}${line ? `:${line}` : ""}`;
  const own = (path: string): boolean =>
    here?.host === u.host && here.path === path;

  if (forge === "github" && p.length >= 2) {
    const repo = `${p[0] ?? ""}/${p[1] ?? ""}`;
    const [kind, n] = [p[2], p[3]];
    if ((kind === "issues" || kind === "pull") && /^\d+$/.test(n ?? ""))
      return {
        label: `${own(repo) ? "" : repo}#${n ?? ""}`,
        kind: kind === "pull" ? "pr" : "issue",
        forge,
      };
    if (kind === "commit" && n)
      return { label: at(repo, n), kind: "commit", forge };
    if ((kind === "blob" || kind === "tree") && p.length > 4)
      return { label: file(repo, p.slice(4)), kind: "file", forge };
    if (p.length === 2) return { label: repo, kind: "page", forge };
  }
  if (forge === "gitlab") {
    const dash = p.indexOf("-");
    if (dash > 1) {
      const repo = p.slice(0, dash).join("/");
      const [kind, n] = [p[dash + 1], p[dash + 2]];
      if (
        (kind === "issues" || kind === "merge_requests") &&
        /^\d+$/.test(n ?? "")
      )
        return {
          label: `${own(repo) ? "" : repo}${kind === "issues" ? "#" : "!"}${n ?? ""}`,
          kind: kind === "issues" ? "issue" : "pr",
          forge,
        };
      if (kind === "commit" && n)
        return { label: at(repo, n), kind: "commit", forge };
      if ((kind === "blob" || kind === "tree") && p.length > dash + 3)
        return { label: file(repo, p.slice(dash + 3)), kind: "file", forge };
    }
  }
  if (forge === "azure") {
    const git = p.indexOf("_git");
    const repo = git > 0 ? p[git + 1] : null;
    if (repo && p[git + 2] === "pullrequest" && /^\d+$/.test(p[git + 3] ?? ""))
      return { label: `${repo}!${p[git + 3] ?? ""}`, kind: "pr", forge };
    if (repo && p[git + 2] === "commit" && p[git + 3])
      return { label: at(repo, p[git + 3] ?? ""), kind: "commit", forge };
    if (repo && u.searchParams.get("path")) {
      const lineParam = u.searchParams.get("line");
      return {
        label: `${repo} › ${u.searchParams.get("path")?.replace(/^\//, "") ?? ""}${lineParam ? `:${lineParam}` : ""}`,
        kind: "file",
        forge,
      };
    }
    const wi = p.indexOf("_workitems");
    if (wi > 0 && p[wi + 1] === "edit" && /^\d+$/.test(p[wi + 2] ?? ""))
      return { label: `AB#${p[wi + 2] ?? ""}`, kind: "workitem", forge };
  }
  if (href.length <= 40) return null;
  const host = u.host.replace(/^www\./, "");
  const path =
    p.length > 2
      ? `/${p[0] ?? ""}/…/${p.at(-1) ?? ""}`
      : p.length
        ? `/${p.join("/")}`
        : "";
  return { label: `${host}${path}`, kind: "page", forge };
}

function urls(
  text: string,
  ft: FeatureOptions,
  here: ForgeRepoInfo | null,
): string {
  const one = (href: string, tail = ""): string | null => {
    const s = shortUrl(href, here);
    if (!s) return null;
    const g = (s.forge ? GLYPH[s.forge] : null) ?? GLYPH.globe;
    const style =
      (
        {
          issue: "issue",
          pr: "pr",
          workitem: "workitem",
          commit: "sha",
        } as Record<string, string>
      )[s.kind] ?? "host";
    return (
      link(mark(style, glyphed(g, ft, esc(s.label)), ft.colour), href) + tail
    );
  };
  return pass(text, /(?!)/, null, (span) => {
    let m = /^[a-z][\w+.-]*:\/\/\S+$/i.exec(span);
    if (m) {
      const execRes = /^(.*?)([.,;:!?]*)$/.exec(span);
      if (execRes?.[1] !== undefined && execRes[2] !== undefined) {
        return one(execRes[1], execRes[2]) ?? span;
      }
    }
    m = /^<(https?:[^>]+)>$/.exec(span);
    if (m?.[1]) return one(m[1]) ?? span;
    m = /^\[(https?:[^\]]+)\]\((https?:[^)]+)\)$/.exec(span);
    if (m?.[1] && m[2] && m[1] === m[2]) return one(m[2]) ?? span;
    return span;
  });
}

const REF =
  /(?<![\w&#/#!@.\\-])(?:([\w-]+(?:\/[\w.-]+)+)|(AB))?([#!])(\d+)(?![\w-])/g;
export const refKey = (
  r: ForgeRepoInfo,
  { repo, sigil, n }: WorkItemReference,
): string =>
  `${r.forge}:${r.host ?? r.org ?? ""}:${repo ?? r.path ?? r.project ?? ""}:${sigil}${String(n)}`;

function refs(
  text: string,
  ft: FeatureOptions,
  here: ForgeRepoInfo | null,
  facts: Facts,
  st: FeatureOptions | null,
): string {
  if (!here) return text;
  return pass(text, REF, (all, repo, ab, sigil, n) => {
    if (!all) return "";
    if (ab && sigil !== "#") return all;
    if (!sigil || !n) return all;
    const ref: WorkItemReference = { repo, sigil: ab ? "AB#" : sigil, n };
    const t = target(here, ref);
    if (!t) return all;
    const s = st ? facts.state(here, ref) : undefined;
    const kind = s?.kind ?? t.kind;
    const icon =
      (s && STATE[kind]?.[s.state]) ?? KIND[kind as keyof typeof KIND].icon;
    const colour = s ? (st?.colour ?? ft.colour) : ft.colour;
    const unsure =
      !s && Boolean(st) && here.forge === "github" && ref.sigil === "#";
    return link(
      mark(
        s ? s.state : kind,
        unsure ? esc(all) : glyphed(icon, ft, esc(all)),
        colour,
      ),
      t.url,
    );
  });
}

export function refsRule(
  here: ForgeRepoInfo | null,
  o: SettingsOutput,
): string | null {
  if (!here || !o.f.replyRefs) return null;
  const name =
    here.forge === "azure"
      ? `${here.org ?? ""}/${here.project ?? ""}`
      : (here.path ?? "");
  const other =
    here.forge === "gitlab"
      ? "`group/project#N` (`!N` for a merge request)"
      : here.forge === "azure"
        ? "its full URL"
        : "`owner/repo#N`";
  return `Work-item references: a bare \`#N\` means an issue or pull request of ${name}, this session's repository. For one of any other repository write ${other}, never a bare \`#N\`.`;
}

const PATH =
  /(?<![\w.~/\\:@$-])(~[/\\](?:[\w.@+-]+[/\\])*[\w.@+-]+|(?:[A-Za-z]:)?[/\\](?:[\w.@+-]+[/\\])+[\w.@+-]*|(?:\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z]\w*(?=:\d))(?::(\d+)(?::(\d+))?)?(?![\w/\\])/g;

const slash = (p: string): string => p.replace(/\\/g, "/");
const parent = (p: string): string =>
  p.slice(0, p.lastIndexOf("/")) || (p.startsWith("/") ? "/" : p);
const isAbs = (p: string): boolean => /^(\/|[A-Za-z]:\/)/.test(p);
const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export function resolvePath(
  p: string,
  { cwd, home }: { cwd?: string; home?: string },
): string {
  let s = slash(p);
  if (s.startsWith("~/")) s = `${slash(home ?? "")}${s.slice(1)}`;
  else if (!isAbs(s)) s = `${slash(cwd ?? "")}/${s}`;
  const drive = /^[A-Za-z]:/.exec(s)?.[0] ?? "";
  const out: string[] = [];
  for (const seg of s.slice(drive.length).split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return `${drive}/${out.join("/")}`;
}

function rootOf(abs: string, facts: Facts): string | null | undefined {
  const dirs: string[] = [];
  for (let d = parent(abs); ; d = parent(d)) {
    dirs.push(d);
    if (parent(d) === d || /^[A-Za-z]:$/.test(d)) break;
  }
  const dot = dirs.map((d) => facts.stat(`${d === "/" ? "" : d}/.git`));
  for (let i = 0; i < dirs.length; i++) {
    if (dot[i] === undefined) return undefined;
    if (dot[i]) return dirs[i] ?? null;
  }
  return null;
}

export function shortPath(
  abs: string,
  root: string | null,
  home?: string,
): { prefix: string; name: string } {
  if (root) {
    const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(root);
    const repo = wt ? `${base(wt[1] ?? "")}[${wt[2] ?? ""}]` : base(root);
    const rel = abs.slice(root.length + 1);
    return {
      prefix: `${repo} › ${rel.includes("/") ? `${parent(rel)}/` : ""}`,
      name: base(rel),
    };
  }
  const h = slash(home ?? "").replace(/\/$/, "");
  const shown =
    h && abs.toLowerCase().startsWith(`${h.toLowerCase()}/`)
      ? `~${abs.slice(h.length)}`
      : abs;
  return {
    prefix: shown.includes("/")
      ? shown.slice(0, shown.lastIndexOf("/") + 1)
      : "",
    name: base(shown),
  };
}

export const EDITORS: Record<string, string> = {
  vscode: "vscode://file{path}:{line}:{col}",
  cursor: "cursor://file{path}:{line}:{col}",
  zed: "zed://file{path}:{line}:{col}",
  idea: "idea://open?file={path}&line={line}&column={col}",
  sublime: "subl://open?url=file://{path}&line={line}&column={col}",
  file: "file://{path}",
};

export function editorUrl(
  abs: string,
  line?: string | number | null,
  col?: string | number | null,
  {
    editor = "vscode",
    editorUrl: custom = "",
  }: { editor?: string; editorUrl?: string } = {},
): string {
  const tpl =
    editor === "custom" && custom
      ? custom
      : (EDITORS[editor] ?? EDITORS.vscode ?? "");
  const path = encodeURI(abs.startsWith("/") ? abs : `/${abs}`);
  return tpl
    .replaceAll("{path}", path)
    .replaceAll("{line}", String(line ?? 1))
    .replaceAll("{col}", String(col ?? 1));
}

function paths(
  text: string,
  o: SettingsOutput,
  facts: Facts,
  ctx: RewriteContext,
): string {
  const [fp, fl] = [o.f.replyPaths, o.f.replyFileLinks];
  if (!fp && !fl) return text;
  const ft = {
    glyph: Boolean(fp?.glyph ?? fl?.glyph),
    colour: Boolean(fp?.colour ?? fl?.colour),
  };
  return pass(text, PATH, (all, raw, line, col) => {
    if (!all || !raw) return "";
    const dots = /\.+$/.exec(raw)?.[0] ?? "";
    const p = raw.slice(0, raw.length - dots.length);
    if (!p || (dots && line)) return all;
    const tail = all.slice(raw.length);
    const abs = resolvePath(p, ctx);
    const absolute = isAbs(slash(p)) || p.startsWith("~");
    const kind = facts.stat(abs);
    const root = fp && absolute ? rootOf(abs, facts) : null;
    if (!kind || root === undefined) return all;
    const shown =
      fp && absolute
        ? shortPath(abs, root, ctx.home)
        : {
            prefix: p.slice(
              0,
              Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1,
            ),
            name: base(slash(p)),
          };
    const g = line ? GLYPH.editor : fileGlyph(shown.name, kind);
    const label =
      (ft.glyph ? `${g} ` : "") +
      mark("dim", esc(shown.prefix), ft.colour) +
      mark("name", esc(shown.name), ft.colour) +
      (tail ? mark("line", tail, ft.colour) : "");
    if (!fl) return label + dots;
    const url =
      kind === "dir"
        ? `file://${encodeURI(abs.startsWith("/") ? abs : `/${abs}`)}`
        : editorUrl(abs, line, col, o);
    return link(label, url) + dots;
  });
}

const SHA =
  /(?<![\w#/@.:-])(?=[0-9a-f]{0,39}[a-f])(?=[0-9a-f]{0,39}\d)[0-9a-f]{7,40}(?![\w-])/g;

export function commitUrl(r: ForgeRepoInfo | null, sha: string): string | null {
  if (!r) return null;
  if (r.forge === "github")
    return `https://${r.host ?? "github.com"}/${r.path ?? ""}/commit/${sha}`;
  if (r.forge === "gitlab")
    return `https://${r.host ?? "gitlab.com"}/${r.path ?? ""}/-/commit/${sha}`;
  return `https://dev.azure.com/${r.org ?? ""}/${r.project ?? ""}/_git/${r.repo ?? ""}/commit/${sha}`;
}

function commits(
  text: string,
  ft: FeatureOptions,
  here: ForgeRepoInfo | null,
  facts: Facts,
): string {
  return pass(text, SHA, (sha) => {
    if (!sha) return "";
    if (facts.commit(sha) !== true) return sha;
    const label = mark("sha", glyphed(GLYPH.commit, ft, sha), ft.colour);
    const url = commitUrl(here, sha);
    return url ? link(label, url) : label;
  });
}

const ISO =
  /(?<![\w:-])(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?![\w:])/g;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function ago(ms: number, now: number): string {
  const d = Math.round((now - ms) / 1000);
  const a = Math.abs(d);
  const v =
    a < 60
      ? `${String(a)}s`
      : a < 3600
        ? `${String(Math.floor(a / 60))}m`
        : a < 86400
          ? `${String(Math.floor(a / 3600))}h`
          : a < 86400 * 60
            ? `${String(Math.floor(a / 86400))}d`
            : a < 86400 * 730
              ? `${String(Math.floor(a / (86400 * 30)))}mo`
              : `${String(Math.floor(a / (86400 * 365)))}y`;
  return d >= 0 ? `${v} ago` : `in ${v}`;
}

export function local(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const year =
    d.getFullYear() === new Date(now).getFullYear()
      ? ""
      : ` ${String(d.getFullYear())}`;
  const month = MONTHS[d.getMonth()] ?? "";
  return `${String(d.getDate())} ${month}${year} ${hm}`;
}

function times(
  text: string,
  ft: FeatureOptions,
  fmt: string,
  now: number,
): string {
  return pass(text, ISO, (all, y, mo, d, h, mi, s, zone) => {
    if (!all || !y || !mo || !d || !h || !mi) return "";
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s || "00"}${zone ? (zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")) : ""}`;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || Number(mo) > 12 || Number(d) > 31) return all;
    const abs = local(ms, now);
    const rel = ago(ms, now);
    const head = fmt === "relative" ? rel : abs;
    const label =
      (ft.glyph ? `${GLYPH.clock} ` : "") +
      mark("time", head, ft.colour) +
      (fmt === "both" ? ` ${mark("dim", `(${rel})`, ft.colour)}` : "");
    return label;
  });
}

const OK =
  /^(?:pass(?:ed|ing)?|ok|success(?:ful)?|succeeded|green|✓|✔|✅|✔️)$/i;
const BAD = /^(?:fail(?:ed|ing|ure)?|errou?red|error|broken|red|✗|✘|❌)$/i;
const SKIP = /^(?:skip(?:ped)?|pending|⊘|⏭|⏭️)$/i;
const STATUS_WORD =
  "(?:pass(?:ed|ing)?|ok|success(?:ful)?|succeeded|green|fail(?:ed|ing|ure)?|errored|error|broken|red|skip(?:ped)?|pending|✓|✔️?|✅|✗|✘|❌|⊘|⏭️?)";
const SYMBOL: Record<string, string> = { ok: "✓", bad: "✗", skip: "⊘" };

const statusOf = (w: string): string | null =>
  OK.test(w) ? "ok" : BAD.test(w) ? "bad" : SKIP.test(w) ? "skip" : null;

function badge(word: string, ft: FeatureOptions): string {
  const s = statusOf(word);
  if (!s) return word;
  const symbolOnly = /^[^\w]+$/.test(word);
  const text = symbolOnly
    ? (SYMBOL[s] ?? "")
    : ft.glyph
      ? `${SYMBOL[s] ?? ""} ${word}`
      : word;
  return mark(s, text, ft.colour);
}

export const summary = (
  n: Record<string, number>,
  ft: FeatureOptions,
): string =>
  ["ok", "bad", "skip"]
    .filter((k) => Boolean(n[k]))
    .map((k) => mark(k, `${String(n[k] ?? 0)} ${SYMBOL[k] ?? ""}`, ft.colour))
    .join(" · ");

const ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;
const TAIL = new RegExp(
  `^(.*?\\S)(\\s*(?::|—|–|\\s-|→|->|=|\\.\\.\\.|…)\\s*|\\s+\\()(\\*{0,2})(${STATUS_WORD})(\\*{0,2})(\\)?)(\\s*\\.?)$`,
  "iu",
);
const HEAD = new RegExp(
  `^(\\*{0,2})(✓|✔️?|✅|✗|✘|❌|⊘|⏭️?|PASS(?:ED)?|FAIL(?:ED)?|OK|SKIP(?:PED)?|ERROR)(\\*{0,2})(:?\\s+)(\\S.*)$`,
  "u",
);
const NAMED = /^(\s*[^\s:|>#-][^:|]{0,60}:\s*)(\S+)(\s*\.?)$/;

function statusText(
  s: string,
  ft: FeatureOptions,
  count: (st: string | null) => void,
): string | null {
  let m = TAIL.exec(s);
  if (m && (!m[6] || (m[2]?.includes("(") ?? false))) {
    count(statusOf(m[4] ?? ""));
    return `${m[1] ?? ""}${m[2] ?? ""}${m[3] ?? ""}${badge(m[4] ?? "", ft)}${m[5] ?? ""}${m[6] ?? ""}${m[7] ?? ""}`;
  }
  m = HEAD.exec(s);
  if (m) {
    count(statusOf(m[2] ?? ""));
    return `${m[1] ?? ""}${badge(m[2] ?? "", ft)}${m[3] ?? ""}${m[4] ?? ""}${m[5] ?? ""}`;
  }
  return null;
}

function status(text: string, ft: FeatureOptions): string {
  const out: string[] = [];
  let n: Record<string, number> | null = null;
  const close = (): void => {
    if (n && (n.ok ?? 0) + (n.bad ?? 0) + (n.skip ?? 0) >= 2)
      out.push("", summary(n, ft));
    n = null;
  };
  let kind: string | null = null;
  for (const [line, keep] of kept(text)) {
    if (keep) {
      close();
      kind = null;
      out.push(line);
      continue;
    }
    const k = /^\s*\|/.test(line) ? "table" : ITEM.test(line) ? "list" : null;
    if (k !== kind) {
      close();
      kind = k;
    }
    if (k) n ??= { ok: 0, bad: 0, skip: 0 };
    const count = (s: string | null): void => {
      if (s && n) n[s] = (n[s] ?? 0) + 1;
    };
    if (k === "table") {
      out.push(
        line.replace(/(?<=\|)([^|]*)(?=\|)/g, (cell) => {
          const w = cell.trim().replace(/^\*\*(.*)\*\*$/, "$1");
          const s = statusOf(w);
          if (!s) return cell;
          count(s);
          return cell.replace(w, badge(w, ft));
        }),
      );
      continue;
    }
    if (k === "list") {
      const execRes = ITEM.exec(line);
      if (execRes?.[1] !== undefined && execRes[2] !== undefined) {
        const lead = execRes[1];
        const body = execRes[2];
        const t = statusText(body, ft, count);
        out.push(t ? lead + t : line);
        continue;
      }
    }
    const m = NAMED.exec(line);
    out.push(
      m?.[1] &&
        m[2] &&
        m[3] !== undefined &&
        statusOf(m[2]) &&
        !line.includes("`")
        ? `${m[1]}${badge(m[2], ft)}${m[3]}`
        : line,
    );
  }
  close();
  return out.join("\n");
}

export const STATE_TTL_MS = 5 * 60_000;
export const MISS_TTL_MS = 30_000;

export function createFacts({
  stat = async () => {
    await Promise.resolve();
    return null;
  },
  commit = async () => {
    await Promise.resolve();
    return false;
  },
  state = async () => {
    await Promise.resolve();
    return null;
  },
  now = Date.now,
}: {
  stat?: (p: string) => Promise<string | null>;
  commit?: (sha: string) => Promise<boolean>;
  state?: (
    r: ForgeRepoInfo,
    ref: WorkItemReference,
  ) => Promise<{ kind: string; state: string } | null>;
  now?: () => number;
} = {}): Facts {
  const known = new Map<string, { v: unknown; at: number }>();
  const pending = new Map<string, Promise<unknown>>();
  const ask = <T,>(
    key: string,
    fn: () => Promise<T>,
    ttl?: { hit: number; miss: number },
  ): T | null | undefined => {
    const k = known.get(key);
    if (k && (!ttl || now() - k.at < (k.v === null ? ttl.miss : ttl.hit)))
      return k.v as T;
    if (!pending.has(key)) {
      const p = Promise.resolve()
        .then(fn)
        .catch(() => null)
        .then((v) => {
          known.set(key, { v: v ?? null, at: now() });
          pending.delete(key);
          return v;
        });
      pending.set(key, p);
    }
    return k?.v as T | undefined;
  };
  return {
    stat: (p: string) => ask(`stat:${p}`, () => stat(p)),
    commit: (sha: string) => ask(`commit:${sha}`, () => commit(sha)),
    state: (r: ForgeRepoInfo, ref: WorkItemReference) =>
      ask(`state:${refKey(r, ref)}`, () => state(r, ref), {
        hit: STATE_TTL_MS,
        miss: MISS_TTL_MS,
      }),
    get pending() {
      return pending.size;
    },
    async settle(ms = 2000): Promise<boolean> {
      if (!pending.size) return false;
      let timer: NodeJS.Timeout | undefined;
      const all = Promise.all([...pending.values()]);
      await Promise.race([
        all,
        new Promise((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return true;
    },
  };
}

export async function fetchState(
  run: (argv: string[]) => Promise<string | null>,
  r: ForgeRepoInfo,
  { repo, sigil, n }: WorkItemReference,
): Promise<{ kind: string; state: string } | null> {
  const json = async (
    argv: string[],
  ): Promise<Record<string, unknown> | null> => {
    try {
      const out = await run(argv);
      return out ? (JSON.parse(out) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  if (r.forge === "github") {
    const j = await json([
      "gh",
      "api",
      "--hostname",
      r.host ?? "github.com",
      `repos/${repo ?? r.path ?? ""}/issues/${String(n)}`,
    ]);
    if (!j?.state) return null;
    if (!j.pull_request)
      return {
        kind: "issue",
        state:
          j.state !== "closed"
            ? "open"
            : j.state_reason === "not_planned"
              ? "not_planned"
              : "completed",
      };
    const pr = j.pull_request as Record<string, unknown>;
    return {
      kind: "pr",
      state: pr.merged_at
        ? "merged"
        : j.state === "closed"
          ? "closed"
          : j.draft
            ? "draft"
            : "open",
    };
  }
  if (r.forge === "gitlab") {
    const mr = sigil === "!";
    const j = await json([
      "glab",
      "api",
      "--hostname",
      r.host ?? "gitlab.com",
      `projects/${encodeURIComponent(repo ?? r.path ?? "")}/${mr ? "merge_requests" : "issues"}/${String(n)}`,
    ]);
    if (!j?.state) return null;
    const state =
      j.state === "merged"
        ? "merged"
        : j.state === "closed"
          ? "closed"
          : j.draft || j.work_in_progress
            ? "draft"
            : "open";
    return { kind: mr ? "pr" : "issue", state };
  }
  const org = `https://dev.azure.com/${r.org ?? ""}`;
  if (sigil === "!") {
    const j = await json([
      "az",
      "repos",
      "pr",
      "show",
      "--id",
      String(n),
      "--org",
      org,
      "--output",
      "json",
    ]);
    if (!j?.status) return null;
    return {
      kind: "pr",
      state:
        j.status === "completed"
          ? "merged"
          : j.status === "abandoned"
            ? "closed"
            : j.isDraft
              ? "draft"
              : "open",
    };
  }
  const j = await json([
    "az",
    "boards",
    "work-item",
    "show",
    "--id",
    String(n),
    "--org",
    org,
    "--output",
    "json",
  ]);
  const fields = j?.fields as Record<string, unknown> | undefined;
  const s = fields?.["System.State"] as string | undefined;
  return s
    ? {
        kind: "workitem",
        state: /closed|done|removed|resolved|completed/i.test(s)
          ? "closed"
          : "open",
      }
    : null;
}

export function rewrite(
  text: string,
  o: SettingsOutput,
  ctx: RewriteContext,
  facts: Facts,
): string {
  if (!text) return text;
  const f = o.f;
  let t = text;
  if (f.replySecrets) t = secrets(t, f.replySecrets);
  if (f.replyUrls) t = urls(t, f.replyUrls, ctx.repo);
  if (f.replyRefs) t = refs(t, f.replyRefs, ctx.repo, facts, f.replyState);
  if (f.replyPaths || f.replyFileLinks) t = paths(t, o, facts, ctx);
  if (f.replyCommits) t = commits(t, f.replyCommits, ctx.repo, facts);
  if (f.replyTimes)
    t = times(t, f.replyTimes, o.timeFormat, ctx.now ?? Date.now());
  if (f.replyStatus) t = status(t, f.replyStatus);
  return t;
}
