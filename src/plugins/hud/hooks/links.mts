import { forgeOf, ICON } from "./weather.mjs";
import type {
  ForgeRepoInfo,
  LinkifyOptions,
  RunnerFn,
  TargetResult,
  WorkItemKind,
  WorkItemReference,
} from "./types.mjs";

export const KIND: Record<
  WorkItemKind,
  { icon: string; rgb: [number, number, number] }
> = {
  issue: { icon: "", rgb: [166, 227, 161] },
  pr: { icon: ICON.pr ?? "", rgb: [203, 166, 247] },
  workitem: { icon: "", rgb: [137, 180, 250] },
};

export function repoOf(remote?: string | null): ForgeRepoInfo | null {
  const url = remote?.trim();
  if (!url) return null;
  const forge = forgeOf(url) ?? (/github/i.test(url) ? "github" : null);
  const m =
    /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec(
      url,
    );
  if (!forge || !m) return null;
  const [, host, path] = m;
  if (!host || !path) return null;
  if (forge !== "azure") return { forge, host, path };
  const p = path.split("/");
  if (p[0] === "v3" && p.length === 4)
    return { forge, org: p[1], project: p[2], repo: p[3] };
  const git = p.indexOf("_git");
  if (git < 1 || !p[git + 1]) return null;
  const vs = /^([^.]+)\.visualstudio\.com$/i.exec(host);
  return {
    forge,
    org: vs ? vs[1] : p[0],
    project: p[git - 1],
    repo: p[git + 1],
  };
}

export function pickRemote(names?: string | null): string | null {
  const n = (names ?? "").split(/\s+/).filter(Boolean);
  return n.includes("upstream")
    ? "upstream"
    : n.includes("origin")
      ? "origin"
      : (n[0] ?? null);
}

export async function linkRepo(run: RunnerFn): Promise<ForgeRepoInfo | null> {
  const name = pickRemote(await run(["git", "remote"]));
  return name ? repoOf(await run(["git", "remote", "get-url", name])) : null;
}

export function target(
  r: ForgeRepoInfo | null,
  { repo, sigil, n }: WorkItemReference,
): TargetResult | null {
  if (!r) return null;
  if (r.forge === "github")
    return sigil === "#" && (!repo || /^[\w-]+\/[\w.-]+$/.test(repo))
      ? {
          url: `https://${r.host ?? "github.com"}/${repo ?? r.path ?? ""}/issues/${String(n)}`,
          kind: "issue",
        }
      : null;
  if (r.forge === "gitlab") {
    const base = `https://${r.host ?? "gitlab.com"}/${repo ?? r.path ?? ""}`;
    return sigil === "#"
      ? { url: `${base}/-/issues/${String(n)}`, kind: "issue" }
      : sigil === "!"
        ? { url: `${base}/-/merge_requests/${String(n)}`, kind: "pr" }
        : null;
  }
  if (repo) return null;
  const base = `https://dev.azure.com/${r.org ?? ""}/${r.project ?? ""}`;
  return sigil === "!"
    ? {
        url: `${base}/_git/${r.repo ?? ""}/pullrequest/${String(n)}`,
        kind: "pr",
      }
    : { url: `${base}/_workitems/edit/${String(n)}`, kind: "workitem" };
}

const SPAN =
  /(`+)[^`]*?\1|\[[^\]\n]*\]\([^)\n]*\)|<[a-z][\w+.-]*:[^>\n]*>|\b[a-z][\w+.-]*:\/\/[^\s)>]+|(?<![\w&#/#!@.\\-])(?:([\w-]+(?:\/[\w.-]+)+)|(AB))?([#!])(\d+)(?![\w-])/g;
const FENCE = /^ {0,3}(```|~~~)/;

export function linkify(
  text: string,
  remote?: string | ForgeRepoInfo | null,
  { format = "markdown", glyph = false, color = false }: LinkifyOptions = {},
): string {
  const r = typeof remote === "string" ? repoOf(remote) : remote;
  if (!r || !text) return text;
  let fence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line)?.[1];
      if (fence) {
        if (f === fence) fence = null;
        return line;
      }
      if (f) {
        fence = f;
        return line;
      }
      return line.replace(
        SPAN,
        (
          all: string,
          _tick: string | undefined,
          repo: string | undefined,
          ab: string | undefined,
          sigil: string | undefined,
          n: string | undefined,
        ) => {
          if (!n || (ab && sigil !== "#")) return all;
          const t = target(r, { repo, sigil: ab ? "AB#" : (sigil ?? ""), n });
          if (!t) return all;
          const k = KIND[t.kind];
          const label = glyph ? `${k.icon} ${all}` : all;
          if (format === "markdown") return `[${label}](${t.url})`;
          const painted = color
            ? `\x1b[38;2;${k.rgb.join(";")}m${label}\x1b[39m`
            : label;
          return `\x1b]8;;${t.url}\x1b\\${painted}\x1b]8;;\x1b\\`;
        },
      );
    })
    .join("\n");
}

export const styled = (
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean => !env?.NO_COLOR;
