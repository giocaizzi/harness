// Runs ticket-run's gate as one call: the reads references/comments.md describes (the issue, its timeline, the body's
// last edit, the comments, the login this session posts as), judged as that reference judges them, printed as one
// JSON verdict on stdout. Readiness (acceptance criteria and a proof command) is the run's own call on the body, so
// the verdict carries the body and leaves it open.
// Usage: node gate.mjs <n>   (from the repo or a worktree; gh fills {owner}/{repo} from the checkout)
// Exit 0 go or wait, 1 stop (the verdict says which check), 2 usage or environment (no checkout, no or unreadable
// .factory/config.yaml on the default branch, no gh). Every read that fails or cannot be judged fails closed: it stops,
// never lets the run on. The config is the one committed on the forge's default branch (committedConfig), never the
// checkout's copy.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type {
  EnvMap,
  GateChecks,
  GateClaimState,
  GateConfig,
  GateLabels,
  GateReads,
  GateStop,
  GateVerdict,
} from "./types.mjs";

export class UsageError extends Error {}
class ReadError extends Error {}

const DEFAULT_MARKER = "<!-- factory -->";
const DEFAULT_LABELS: GateLabels = {
  approval: "agent-ok",
  claimed: "factory-claimed",
  needs_grooming: "needs-grooming",
  takeover: "factory-takeover",
};
const CLAIM_TAG = "<!-- factory:claim -->";
const PAGE = 100; // one timeline page; 100 events or more refuse, as the reference does, rather than judge a partial history

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const parseJson = (text: string): unknown => JSON.parse(text);

const toStr = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : "";

const errCode = (e: unknown): string | undefined =>
  isRecord(e) && typeof e.code === "string" ? e.code : undefined;

const errMsg = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : isRecord(e) && typeof e.message === "string"
      ? e.message
      : typeof e;

const errStderr = (e: unknown): string => {
  if (!isRecord(e)) return "";
  if (typeof e.stderr === "string") return e.stderr;
  if (Buffer.isBuffer(e.stderr)) return e.stderr.toString("utf8");
  return "";
};

const lc = (s: unknown): string => toStr(s).toLowerCase();
const cut = (s: string, n = 300): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

// --- .factory/config.yaml: only the keys the gate reads, in the plain YAML the template uses ---

// A line without its comment: a `#` at the start or after a space, outside quotes.
const uncomment = (line: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i);
    }
  }
  return line;
};

const scalar = (raw: string, key: string): string => {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      const parsed: unknown = parseJson(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // handled below
    }
    throw new UsageError(
      `.factory/config.yaml: ${key} has a double-quoted value the gate cannot read`,
    );
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) {
      throw new UsageError(
        `.factory/config.yaml: ${key} has a single-quoted value the gate cannot read`,
      );
    }
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
};

/** The gate's keys from the config text: approvers, writers, approvers_allow_bots, labels, marker, and identity.logins (for change runs). Throws UsageError when one cannot be read. */
export const parseConfig = (text: string): GateConfig => {
  const top: Record<string, { inline: string; block: string[] }> = {};
  let current: { inline: string; block: string[] } | null = null;
  let first = true;
  for (const raw of text
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split("\n")) {
    const line = uncomment(raw).trimEnd();
    if (!line.trim()) continue;
    if (first && line === "---") {
      first = false;
      continue;
    }
    first = false;
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (m?.[1]) {
      current = { inline: (m[2] ?? "").trim(), block: [] };
      top[m[1]] = current;
    } else if ((/^\s/.test(line) || /^-\s/.test(line)) && current) {
      current.block.push(line.startsWith("-") ? ` ${line}` : line);
    } else {
      throw new UsageError(
        `.factory/config.yaml: cannot read the line ${JSON.stringify(cut(raw, 80))}`,
      );
    }
  }
  const list = (key: string): string[] | undefined => {
    const e = top[key];
    if (!e) return undefined;
    if (e.inline.startsWith("[")) {
      if (!e.inline.endsWith("]") || e.block.length) {
        throw new UsageError(
          `.factory/config.yaml: ${key} is a list the gate cannot read`,
        );
      }
      const body = e.inline.slice(1, -1).trim();
      return body ? body.split(",").map((x) => scalar(x, key)) : [];
    }
    if (e.inline)
      throw new UsageError(`.factory/config.yaml: ${key} must be a list`);
    return e.block.map((l) => {
      const item = /^\s+-\s+(.+)$/.exec(l);
      if (!item?.[1]) {
        throw new UsageError(
          `.factory/config.yaml: ${key} is a list the gate cannot read`,
        );
      }
      return scalar(item[1], key);
    });
  };
  const approvers = list("approvers");
  if (!approvers?.length || approvers.some((a) => !a)) {
    throw new UsageError(
      ".factory/config.yaml: approvers must list at least one login",
    );
  }
  const writers = list("writers");
  const bots = top.approvers_allow_bots
    ? scalar(top.approvers_allow_bots.inline, "approvers_allow_bots")
    : "false";
  if (bots !== "true" && bots !== "false") {
    throw new UsageError(
      ".factory/config.yaml: approvers_allow_bots must be true or false",
    );
  }
  const labels: GateLabels = { ...DEFAULT_LABELS };
  if (top.labels) {
    if (top.labels.inline) {
      throw new UsageError(
        ".factory/config.yaml: labels must be a block mapping",
      );
    }
    const indent = /^\s*/.exec(top.labels.block[0] ?? "")?.[0].length ?? 0;
    for (const l of top.labels.block) {
      const kv = /^(\s+)([A-Za-z_]\w*):\s*(.*)$/.exec(l);
      if (
        !kv?.[1] ||
        !kv[2] ||
        kv[3] === undefined ||
        kv[1].length !== indent
      ) {
        throw new UsageError(
          ".factory/config.yaml: labels is a mapping the gate cannot read",
        );
      }
      const labelKey = kv[2];
      const name = scalar(kv[3], `labels.${labelKey}`);
      if (!name)
        throw new UsageError(
          `.factory/config.yaml: labels.${labelKey} is empty`,
        );
      if (
        labelKey === "approval" ||
        labelKey === "claimed" ||
        labelKey === "needs_grooming" ||
        labelKey === "takeover"
      ) {
        labels[labelKey] = name;
      }
    }
  }
  const marker = top.marker ? scalar(top.marker.inline, "marker") : "";
  // identity.logins: a list under the block mapping identity (its other keys, such as mention, are not read here).
  const identityLogins: string[] = [];
  if (top.identity) {
    if (top.identity.inline) {
      throw new UsageError(
        ".factory/config.yaml: identity must be a block mapping",
      );
    }
    const block = top.identity.block;
    const indent = /^\s*/.exec(block[0] ?? "")?.[0].length ?? 0;
    for (let i = 0; i < block.length; i++) {
      const line = block[i] ?? "";
      const kv = /^(\s+)([A-Za-z_]\w*):\s*(.*)$/.exec(line);
      const depth = /^\s*/.exec(line)?.[0].length ?? 0;
      if (depth > indent) continue;
      if (!kv?.[2] || kv[3] === undefined || depth !== indent) {
        throw new UsageError(
          ".factory/config.yaml: identity is a mapping the gate cannot read",
        );
      }
      if (kv[2] !== "logins") continue;
      const inline = kv[3].trim();
      if (inline.startsWith("[")) {
        if (!inline.endsWith("]")) {
          throw new UsageError(
            ".factory/config.yaml: identity.logins is a list the gate cannot read",
          );
        }
        const body = inline.slice(1, -1).trim();
        if (body)
          identityLogins.push(
            ...body.split(",").map((x) => scalar(x, "identity.logins")),
          );
      } else if (inline) {
        throw new UsageError(
          ".factory/config.yaml: identity.logins must be a list",
        );
      } else {
        for (
          let j = i + 1;
          j < block.length &&
          (/^\s*/.exec(block[j] ?? "")?.[0].length ?? 0) > indent;
          j++
        ) {
          const item = /^\s+-\s+(.+)$/.exec(block[j] ?? "");
          if (!item?.[1]) {
            throw new UsageError(
              ".factory/config.yaml: identity.logins is a list the gate cannot read",
            );
          }
          identityLogins.push(scalar(item[1], "identity.logins"));
        }
      }
    }
    if (identityLogins.some((l) => !l)) {
      throw new UsageError(
        ".factory/config.yaml: identity.logins has an empty login",
      );
    }
  }
  return {
    approvers,
    writers: writers ?? null,
    approversAllowBots: bots === "true",
    labels,
    marker: marker || DEFAULT_MARKER,
    identityLogins,
  };
};

// --- the judgement, pure: every input is what one read returned ---

const lines = (body: unknown): string[] =>
  toStr(body)
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));

const fields = (body: unknown): Record<string, string> =>
  Object.fromEntries(
    lines(body)
      .slice(2)
      .flatMap((l): [string, string][] => {
        const m = /^([a-z][a-z ]*):\s*(.*)$/.exec(l);
        return m?.[1] !== undefined && m[2] !== undefined
          ? [[m[1], m[2].trim()]]
          : [];
      }),
  );

const shortHost = (h: unknown): string => lc(toStr(h).split(".")[0] ?? "");

/** Computes the gate verdict (`go`, `wait`, or `stop`) and per-check breakdown from the collected forge reads. */
export const judge = ({
  config,
  env,
  host,
  login,
  issue,
  timeline,
  edit,
  comments,
}: GateReads): GateVerdict => {
  const { approvers, labels, marker } = config;
  const rawLabels = Array.isArray(issue.labels) ? issue.labels : [];
  const on = new Set(
    rawLabels.map((l: unknown) => (isRecord(l) ? lc(l.name) : "")),
  );
  const has = (name: string): boolean => on.has(lc(name));
  const inList = (list: readonly string[], u: unknown): u is string =>
    typeof u === "string" && list.map(lc).includes(lc(u));
  const writers = [...(config.writers ?? approvers), ...(login ? [login] : [])];
  const marked = (c: Record<string, unknown>): boolean =>
    typeof c.body === "string" && c.body.startsWith(marker);
  const trusted = comments.filter((c) => marked(c) && inList(writers, c.login));
  const isClaim = (c: Record<string, unknown>): boolean =>
    lines(c.body)[1] === CLAIM_TAG;
  const claims: Record<string, unknown>[] = trusted
    .filter(isClaim)
    .map((c) => ({
      id: c.id,
      url: c.html_url,
      login: c.login,
      ...fields(c.body),
    }));
  const timelineEvents: Record<string, unknown>[] = Array.isArray(timeline)
    ? timeline.filter(isRecord)
    : [];
  const partial = !Array.isArray(timeline) || timeline.length >= PAGE;
  const PARTIAL = `refuse: the timeline has ${String(PAGE)} or more events, more than one read covers`;
  const eventLabelName = (e: Record<string, unknown>): string =>
    isRecord(e.label) && typeof e.label.name === "string" ? e.label.name : "";
  const eventActorLogin = (e: Record<string, unknown>): string | null =>
    isRecord(e.actor) && typeof e.actor.login === "string"
      ? e.actor.login
      : null;
  const lastEvent = (
    label: string,
    kinds: readonly string[],
  ): Record<string, unknown> | undefined =>
    [...(partial ? [] : timelineEvents)]
      .reverse()
      .find(
        (e) =>
          typeof e.event === "string" &&
          kinds.includes(e.event) &&
          lc(eventLabelName(e)) === lc(label),
      );

  // Approved and not edited since: the reference's edit check, which judges the approval too.
  const apr = (u: unknown): boolean =>
    inList(approvers, u) &&
    (config.approversAllowBots || !lc(u).endsWith("[bot]"));
  const approved = ((): string => {
    if (partial) return PARTIAL;
    const approval = lastEvent(labels.approval, ["labeled", "unlabeled"]);
    if (
      approval?.event !== "labeled" ||
      !apr(eventActorLogin(approval)) ||
      !has(labels.approval)
    ) {
      return "refuse: not approved by an approver";
    }
    if (
      !isRecord(edit) ||
      !("lastEditedAt" in edit) ||
      (edit.lastEditedAt !== null && typeof edit.lastEditedAt !== "string")
    ) {
      return "refuse: the last edit of the body could not be read";
    }
    // No string time: '' orders below every string, as the jq filter's null does, so an edit counts as after the approval.
    const at =
      typeof approval.created_at === "string" ? approval.created_at : "";
    // The gate counts a rename with no string time as after the approval. That agrees with the jq filter when the approval has no time either; otherwise it can only refuse where the filter lets the ticket through (fail closed; GitHub always sends a string time).
    const rename = timelineEvents
      .filter(
        (e) =>
          e.event === "renamed" &&
          (typeof e.created_at !== "string" || e.created_at >= at),
      )
      .at(-1);
    const editorLogin =
      isRecord(edit.editor) && typeof edit.editor.login === "string"
        ? edit.editor.login
        : "an unknown editor";
    if (edit.lastEditedAt !== null && edit.lastEditedAt >= at) {
      return `refuse: body edited after approval by ${editorLogin}`;
    }
    if (rename) {
      return `refuse: title renamed after approval by ${eventActorLogin(rename) ?? "an unknown actor"}`;
    }
    return "ok";
  })();

  const runId = (env.FACTORY_RUN_ID ?? "").trim();
  // Takeover counts only in an attended run, applied by an approver (approvers_allow_bots does not apply here).
  const takeover =
    runId || !has(labels.takeover)
      ? null
      : ((): string => {
          if (partial) return PARTIAL;
          const e = lastEvent(labels.takeover, ["labeled", "unlabeled"]);
          return e?.event === "labeled" && inList(approvers, eventActorLogin(e))
            ? "takeover"
            : "ignore: the takeover label was not applied by an approver";
        })();

  const claimOn = has(labels.claimed);
  const newest = claims.at(-1) ?? null;
  let claim: GateClaimState;
  if (runId) {
    const mine = claims.filter((c) => c["run id"] === runId);
    const runtimeMine = mine
      .filter((c) => lc(c.runner ?? "") === "runtime")
      .at(-1);
    if (!claimOn) {
      claim = runtimeMine
        ? { state: "own", comment_id: runtimeMine.id, url: runtimeMine.url }
        : { state: "none" };
    } else if (!mine.length) {
      // Runtime claim not from a writer: name the claim label's last labeled actor only when exactly one marked claim
      // with this run id is theirs; print logins only, never a body.
      const lastClaim = lastEvent(labels.claimed, ["labeled"]);
      const actor = partial || !lastClaim ? null : eventActorLogin(lastClaim);
      const copies = comments
        .filter(
          (c) =>
            marked(c) &&
            isClaim(c) &&
            lines(c.body).includes(`run id: ${runId}`),
        )
        .map((c) => toStr(c.login));
      const named =
        actor && copies.filter((l) => lc(l) === lc(actor)).length === 1
          ? actor
          : null;
      claim = { state: "untrusted", login: named };
    } else if (
      newest?.["run id"] === runId &&
      lc(newest.runner ?? "") === "runtime"
    ) {
      claim = { state: "own", comment_id: newest.id, url: newest.url };
    } else {
      claim = { state: "other", newest };
    }
  } else if (!claimOn) {
    claim = { state: "none" };
  } else if (
    newest &&
    lc(newest.runner ?? "") === "attended" &&
    shortHost(newest.host) === shortHost(host)
  ) {
    claim = { state: "own", comment_id: newest.id, url: newest.url };
  } else if (
    newest &&
    lc(newest.runner ?? "") === "runtime" &&
    takeover === "takeover"
  ) {
    claim = { state: "held", newest };
  } else {
    claim = { state: "other", newest };
  }

  const checks: GateChecks = {
    open: lc(issue.state) === "open",
    approved,
    grooming: has(labels.needs_grooming),
    takeover,
    claim,
  };
  const stop = (
    check: string,
    reason: string,
    reason_code: string | null = null,
  ): { verdict: "stop"; stop: GateStop; checks: GateChecks } => ({
    verdict: "stop",
    stop: { check, reason, reason_code },
    checks,
  });
  const base = {
    checks,
    ready:
      "judge from body: acceptance criteria and a proof command; without them ask on the ticket (a park, not a stop)",
    body: typeof issue.body === "string" ? issue.body : "",
  };
  if (!checks.open) return { ...base, ...stop("open", "the issue is closed") };
  if (approved !== "ok") return { ...base, ...stop("approved", approved) };
  if (checks.grooming) {
    return {
      ...base,
      ...stop(
        "grooming",
        `the ${labels.needs_grooming} label is on: the owner removes it once the ticket is refined`,
      ),
    };
  }
  if (claim.state === "untrusted") {
    const reason = claim.login
      ? `the runtime's claim is by \`${claim.login}\`, which is not in \`writers\`: check it is the runtime's login, then add \`${claim.login}\` to \`writers\` in \`.factory/config.yaml\``
      : "no trusted claim carries this run's id (`FACTORY_RUN_ID`); if the runtime posts under its own login, add that login to `writers` in `.factory/config.yaml`";
    return { ...base, ...stop("claim", reason, "auth") };
  }
  if (claim.state === "other") {
    const detail = claim.newest
      ? ` (run id ${typeof claim.newest["run id"] === "string" ? claim.newest["run id"] : "unknown"}, runner ${typeof claim.newest.runner === "string" ? claim.newest.runner : "unknown"}, ${typeof claim.newest.url === "string" ? claim.newest.url : ""})`
      : " (the claim label is on and no trusted claim is this run's)";
    return {
      ...base,
      ...stop("claim", `claimed by another run${detail}`),
    };
  }
  if (claim.state === "held")
    return { ...base, verdict: "wait", stop: null, checks };
  return {
    ...base,
    verdict: "go",
    stop: null,
    checks,
    claim:
      claim.state === "own"
        ? { action: "edit", comment_id: claim.comment_id }
        : { action: "post" },
  };
};

// --- the reads ---

/** Returns a git environment map with `GIT_TERMINAL_PROMPT` forced to `"0"`. */
export const gitEnv = (
  env: EnvMap = process.env,
): EnvMap & { GIT_TERMINAL_PROMPT: "0" } => ({
  ...env,
  GIT_TERMINAL_PROMPT: "0",
});

const git = (args: readonly string[]): string =>
  execFileSync("git", args, {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    windowsHide: true,
  });

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * .factory/config.yaml as committed on the default branch, never the checkout's copy: a run may stand on a branch (a
 * change's) where a writer or the session changed it. The default branch and its head commit come from the remote
 * (`git ls-remote --symref origin HEAD`), not from local refs (`origin/HEAD`, `update-ref`), and the file is read from
 * that commit, from the repo root whatever the cwd, with replace objects off, so `git replace` cannot swap it. The
 * commit must be fetched. A session that rewrites its own git config (the origin URL, `insteadOf`) can still point
 * this at another repo: that limit stays until the read goes through the forge's API. Returns the text, or null when
 * that commit has no such file; throws when any of it cannot be read.
 */
export const committedConfig = (
  run: (args: readonly string[]) => string = git,
): string | null => {
  const out = run(["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1];
  const sha = /^(\S+)\tHEAD$/m.exec(out)?.[1];
  if (!branch || !sha || !SHA.test(sha)) {
    throw new Error(
      "git ls-remote --symref origin HEAD named no default branch and head",
    );
  }
  try {
    run(["--no-replace-objects", "cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    throw new Error(
      `the head of the default branch ${branch} (${sha.slice(0, 12)}) is not fetched: run git fetch origin ${branch}`,
    );
  }
  if (
    run([
      "--no-replace-objects",
      "ls-tree",
      "--full-tree",
      "--name-only",
      sha,
      "--",
      ".factory/config.yaml",
    ]).trim() === ""
  ) {
    return null;
  }
  return run(["--no-replace-objects", "show", `${sha}:.factory/config.yaml`]);
};

const gh = (args: readonly string[]): string => {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e: unknown) {
    if (errCode(e) === "ENOENT")
      throw new UsageError("gh is not installed or not on PATH");
    const detail = (errStderr(e) || errMsg(e)).trim().split("\n")[0] ?? "";
    throw new ReadError(
      `gh ${args.slice(0, 2).join(" ")} failed: ${cut(detail)}`,
    );
  }
};

const json = (text: string, what: string): unknown => {
  try {
    return parseJson(text);
  } catch {
    throw new ReadError(`${what}: not valid JSON`);
  }
};

/** Reads the authenticated login, issue metadata, timeline, last edit, and comments via `gh`. */
export const read = (
  n: number,
): {
  login: string | null;
  issue: Record<string, unknown>;
  timeline: unknown;
  edit: unknown;
  comments: Record<string, unknown>[];
} => {
  let login: string | null = null;
  try {
    login = gh(["api", "user", "--jq", ".login"]).trim() || null;
  } catch (e: unknown) {
    if (e instanceof UsageError) throw e;
    // an App token cannot read /user: its <slug>[bot] must then be in writers
  }
  const rawIssue = json(
    gh(["issue", "view", String(n), "--json", "state,labels,body"]),
    "issue",
  );
  const issue = isRecord(rawIssue) ? rawIssue : {};
  const timeline = json(
    gh([
      "api",
      `repos/{owner}/{repo}/issues/${String(n)}/timeline?per_page=${String(PAGE)}`,
    ]),
    "timeline",
  );
  const editText = gh([
    "api",
    "graphql",
    "-F",
    `n=${String(n)}`,
    "-F",
    "owner=:owner",
    "-F",
    "name=:repo",
    "--jq",
    ".data.repository.issue",
    "-f",
    "query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt editor{login}}}}",
  ]).trim();
  const edit = editText ? json(editText, "last edit") : null;
  const comments = gh([
    "api",
    `repos/{owner}/{repo}/issues/${String(n)}/comments`,
    "--paginate",
    "--jq",
    ".[] | {id, login: .user.login, created_at, html_url, body}",
  ])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const parsed = json(l, "comments");
      return isRecord(parsed) ? parsed : {};
    });
  return { login, issue, timeline, edit, comments };
};

const parseNumber = (argv: readonly string[], env: EnvMap): number => {
  const first = argv[0];
  if (argv.length !== 1 || first === undefined || !/^#?[1-9]\d*$/.test(first)) {
    throw new UsageError("usage: node gate.mjs <issue number>");
  }
  const n = Number(first.replace("#", ""));
  const ticket = (env.FACTORY_TICKET ?? "").trim();
  if (ticket && !ticket.endsWith(`#${String(n)}`)) {
    throw new UsageError(
      `issue ${String(n)} is not FACTORY_TICKET ${JSON.stringify(cut(ticket, 200))}`,
    );
  }
  return n;
};

const main = (argv: readonly string[], env: EnvMap): number => {
  const n = parseNumber(argv, env);
  try {
    git(["rev-parse", "--show-toplevel"]);
  } catch {
    throw new UsageError(
      "not inside a git checkout: run it from the repo or one of its worktrees",
    );
  }
  let text: string | null;
  try {
    text = committedConfig();
  } catch (e: unknown) {
    const errLine = errStderr(e).trim().split("\n")[0];
    const detail = errLine && errLine.length > 0 ? errLine : errMsg(e);
    throw new UsageError(
      `.factory/config.yaml: cannot read it from the default branch (${cut(detail, 200)})`,
    );
  }
  if (text === null) {
    throw new UsageError(
      ".factory/config.yaml: missing on the default branch: adopt the repo first and merge the config (https://github.com/giocaizzi/harness/blob/main/docs/adopt-factory.md)",
    );
  }
  const config = parseConfig(text);
  let verdict: {
    number: number;
    verdict: "go" | "wait" | "stop";
    stop: GateStop | null;
    checks: GateChecks | null;
    body: string | null;
    ready: string | null;
    claim?: { action: "edit"; comment_id: unknown } | { action: "post" };
  };
  try {
    verdict = {
      number: n,
      ...judge({ config, env, host: hostname(), ...read(n) }),
    };
  } catch (e: unknown) {
    if (!(e instanceof ReadError)) throw e;
    verdict = {
      number: n,
      verdict: "stop",
      stop: {
        check: "read",
        reason: `${e.message}: a read that fails counts as no`,
        reason_code: null,
      },
      checks: null,
      body: null,
      ready: null,
    };
  }
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.verdict === "stop" ? 1 : 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (e: unknown) {
    console.error(
      e instanceof UsageError ? e.message : `gate failed: ${errMsg(e)}`,
    );
    process.exitCode = 2;
  }
}
