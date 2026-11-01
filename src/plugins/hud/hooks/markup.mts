const [OPEN, SEP, CLOSE] = ["\uFDD0", "\uFDD1", "\uFDD2"];
export const MARK = new RegExp(
  `${OPEN}([^${SEP}]*)${SEP}([^${CLOSE}]*)${CLOSE}`,
  "g",
);

export const mark = (style: string, text: string, colour = true): string =>
  colour && text ? `${OPEN}${style}${SEP}${text}${CLOSE}` : text;
export const unmark = (text: string): string => text.replace(MARK, "$2");

export const STYLE: Record<string, Record<string, unknown>> = {
  dim: { dimColor: true },
  name: { bold: true },
  line: { color: "#fab387" },
  sha: { color: "#f9e2af" },
  ok: { color: "success" },
  bad: { color: "error" },
  skip: { dimColor: true },
  open: { color: "success" },
  merged: { color: "merged" },
  completed: { color: "merged" },
  not_planned: { color: "inactive" },
  closed: { color: "error" },
  draft: { color: "inactive" },
  issue: { color: "#a6e3a1" },
  pr: { color: "#cba6f7" },
  workitem: { color: "#89b4fa" },
  host: { color: "#89b4fa" },
  time: { color: "#94e2d5" },
  secret: { color: "warning" },
};

export const escapeMd = (s: string): string => s.replace(/[\\`*_[\]]/g, "\\$&");
const unescape = (s: string): string =>
  s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, "$1");

const LINK = /\[((?:\\.|[^\]\\\n])*)\]\(([^)\s]*)\)/;
const OTHER_SCHEME = /\]\((?!https?:|file:)[a-z][\w+.-]*:/i;
const INLINE = new RegExp(
  `${MARK.source}|${LINK.source}|(\`+)([^\`]+?)\\5|\\*\\*(.+?)\\*\\*|(?<![\\w*])\\*(?![\\s*])(.+?)(?<![\\s*])\\*(?![\\w*])`,
  "g",
);
const CODE = { color: "#b4befe" };

export interface ElementBuilders {
  Box: (props: Record<string, unknown>) => unknown;
  Text: (props: Record<string, unknown>) => unknown;
  Link: (props: Record<string, unknown>) => unknown;
  Markdown: (props: Record<string, unknown>) => unknown;
}

export interface Run {
  text: string;
  props: Record<string, unknown>;
  href?: string;
}

function spans(
  s: string,
  base: Record<string, unknown> = {},
  href?: string,
  out: Run[] = [],
): Run[] {
  let at = 0;
  const plain = (t?: string): void => {
    if (t) out.push({ text: unescape(t), props: base, href });
  };
  for (const m of s.matchAll(INLINE)) {
    const idx = m.index;
    plain(s.slice(at, idx));
    at = idx + m[0].length;
    const [, style, marked, label, linkUrl, , code, bold, italic] = m;
    if (style !== undefined && marked !== undefined) {
      out.push({
        text: unescape(marked),
        props: { ...base, ...STYLE[style] },
        href,
      });
    } else if (linkUrl !== undefined && label !== undefined) {
      spans(label, base, linkUrl, out);
    } else if (code !== undefined) {
      out.push({ text: code, props: CODE, href });
    } else if (bold !== undefined) {
      spans(bold, { ...base, bold: true }, href, out);
    } else if (italic !== undefined) {
      spans(italic, { ...base, italic: true }, href, out);
    }
  }
  plain(s.slice(at));
  return out;
}

const drawRun = (
  r: Run,
  el: ElementBuilders,
  base: Record<string, unknown>,
): unknown =>
  r.props === base ? r.text : el.Text({ ...r.props, children: [r.text] });

function draw(
  rs: Run[],
  el: ElementBuilders,
  base: Record<string, unknown> = {},
): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < rs.length; i++) {
    const curr = rs[i];
    if (!curr) continue;
    const { href } = curr;
    if (!href) {
      out.push(drawRun(curr, el, base));
      continue;
    }
    let j = i;
    while (j < rs.length && rs[j]?.href === href) j++;
    out.push(
      el.Link({
        href,
        children: rs.slice(i, j).map((r) => drawRun(r, el, base)),
      }),
    );
    i = j - 1;
  }
  return out.length ? out : [""];
}

export const inline = (
  s: string,
  el: ElementBuilders,
  base: Record<string, unknown> = {},
): unknown[] => draw(spans(s, base), el, base);

function row(line: string, el: ElementBuilders): unknown {
  const h = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
  if (h?.[1])
    return el.Text({ bold: true, children: inline(h[1], el, { bold: true }) });
  const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (li?.[1] !== undefined && li[2] !== undefined && li[3] !== undefined)
    return el.Text({
      children: [
        `${li[1]}${/\d/.test(li[2]) ? li[2] : "-"} `,
        ...inline(li[3], el),
      ],
    });
  const q = /^\s*>\s?(.*)$/.exec(line);
  if (q?.[1] !== undefined)
    return el.Text({ dimColor: true, children: ["▎ ", ...inline(q[1], el)] });
  return el.Text({ children: inline(line, el) });
}

const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}\u200B-\u200F\u2060\uFE00-\uFE0E]/u;

export const cellWidth = (s: string): number => {
  let w = 0;
  for (const ch of s)
    w += ch === "\uFE0F" ? 1 : ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1;
  return w;
};

const split = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line: string): string[] | null =>
  SEPARATOR.test(line) && line.includes("-") ? null : split(line);
const ALIGN: Record<string, string> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};
const alignOf = (sep: string): string =>
  /^:-+:$/.test(sep) ? "center" : sep.endsWith("-:") ? "right" : "left";

function wrap(rs: Run[], width: number): Run[][] {
  const resultLines: Run[][] = [[]];
  let used = 0;
  const put = (r: Run, text: string): void => {
    const curLine = resultLines[resultLines.length - 1];
    if (curLine) curLine.push({ ...r, text });
    used += cellWidth(text);
  };
  for (const r of rs) {
    const words = r.text.split(/(\s+)/);
    for (const w of words) {
      if (!w) continue;
      const wlen = cellWidth(w);
      if (/^\s+$/.test(w)) {
        if (used + wlen <= width) put(r, w);
        else {
          resultLines.push([]);
          used = 0;
        }
        continue;
      }
      if (used && used + wlen > width) {
        resultLines.push([]);
        used = 0;
      }
      if (wlen <= width) {
        put(r, w);
        continue;
      }
      for (const ch of w) {
        const clen = cellWidth(ch);
        if (used + clen > width) {
          resultLines.push([]);
          used = 0;
        }
        put(r, ch);
      }
    }
  }
  return resultLines;
}

function table(lines: string[], el: ElementBuilders, room?: number): unknown[] {
  const rows = lines.map(cells);
  const sep = lines.find((_l, i) => rows[i] === null);
  const body = rows.filter((r): r is string[] => r !== null);
  const n = Math.max(0, ...body.map((r) => r.length));
  const aligns = sep ? split(sep).map(alignOf) : [];
  const content = rows.map((r, i) =>
    r
      ? Array.from({ length: n }, (_, c) =>
          spans(r[c] ?? "", i === 0 && rows[1] === null ? { bold: true } : {}),
        )
      : null,
  );
  const natural = (rs: Run[]): number =>
    rs.reduce((width, run) => width + cellWidth(run.text), 0);
  const longest = (rs: Run[]): number =>
    Math.max(1, ...rs.flatMap((run) => run.text.split(/\s+/).map(cellWidth)));
  const validContent = content.filter((r): r is Run[][] => r !== null);
  const w = Array.from({ length: n }, (_, c) =>
    Math.max(1, ...validContent.map((r) => natural(r[c] ?? []))),
  );
  const floor = w.map((x, c) =>
    Math.min(
      x,
      Math.max(
        3,
        Math.min(12, Math.max(...validContent.map((r) => longest(r[c] ?? [])))),
      ),
    ),
  );
  const avail = room ? room - (3 * n + 1) : Infinity;
  while (w.reduce((a, b) => a + b, 0) > avail) {
    const c = w.reduce(
      (best, x, i) =>
        x > (floor[i] ?? 0) && (best < 0 || x > (w[best] ?? 0)) ? i : best,
      -1,
    );
    if (c < 0) break;
    const curW = w[c];
    if (curW !== undefined) w[c] = curW - 1;
  }
  const dim = (s: string): unknown =>
    el.Text({ dimColor: true, children: [s] });
  const rule = (l: string, m: string, right: string): unknown =>
    dim(l + w.map((x) => "─".repeat(x + 2)).join(m) + right);
  const out: unknown[] = [rule("┌", "┬", "┐")];
  for (const r of content) {
    if (!r) {
      out.push(rule("├", "┼", "┤"));
      continue;
    }
    const wrapped = r.map((rs, c) => wrap(rs, w[c] ?? 1));
    const height = Math.max(...wrapped.map((l) => l.length));
    for (let k = 0; k < height; k++) {
      const kids: unknown[] = [dim("│ ")];
      wrapped.forEach((ls, c) => {
        const line = ls[k] ?? [];
        kids.push(
          el.Box({
            width: w[c],
            flexShrink: 0,
            justifyContent: ALIGN[aligns[c] ?? "left"],
            children: [
              el.Text({ wrap: "truncate-end", children: draw(line, el) }),
            ],
          }),
        );
        kids.push(dim(c < n - 1 ? " │ " : " │"));
      });
      out.push(el.Box({ flexDirection: "row", children: kids }));
    }
  }
  out.push(rule("└", "┴", "┘"));
  return out;
}

const FENCE = /^ {0,3}(```|~~~)/;
const isTable = (l: string): boolean => /^\s*\|/.test(l);
const startsTable = (rawLines: string[], i: number): boolean =>
  isTable(rawLines[i] ?? "") ||
  (/(?<!\\)\|/.test(rawLines[i] ?? "") &&
    SEPARATOR.test(rawLines[i + 1] ?? "") &&
    (rawLines[i + 1]?.includes("|") ?? false));
const own = (l: string): boolean => l.includes(OPEN) || OTHER_SCHEME.test(l);

export function toTree(
  text: string,
  el: ElementBuilders,
  { first = false, columns = 0 }: { first?: boolean; columns?: number } = {},
): unknown {
  if (!text.includes(OPEN)) return null;
  const rawLines = text.split("\n");
  const blocks: unknown[] = [];
  let md: string[] = [];
  const flush = (): void => {
    while (md.length && !md[0]?.trim()) md.shift();
    const gap = md.length && !md[md.length - 1]?.trim();
    while (md.length && !md[md.length - 1]?.trim()) md.pop();
    if (md.length) blocks.push(el.Markdown({ text: md.join("\n") }));
    if (gap) blocks.push(el.Text({ children: [" "] }));
    md = [];
  };
  let fence: string | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i] ?? "";
    const f = FENCE.exec(l)?.[1];
    if (fence || f) {
      if (fence && f === fence) fence = null;
      else if (!fence && f) fence = f;
      md.push(l);
      continue;
    }
    if (startsTable(rawLines, i)) {
      let j = i + 1;
      while (
        j < rawLines.length &&
        rawLines[j]?.trim() &&
        /(?<!\\)\|/.test(rawLines[j] ?? "")
      )
        j++;
      const t = rawLines.slice(i, j);
      if (t.some(own)) {
        flush();
        blocks.push(...table(t, el, columns ? columns - 2 : undefined));
      } else md.push(...t);
      i = j - 1;
      continue;
    }
    if (!own(l)) {
      if (!l.trim() && !md.length && blocks.length)
        blocks.push(el.Text({ children: [" "] }));
      else md.push(l);
      continue;
    }
    flush();
    blocks.push(row(l, el));
  }
  flush();
  return el.Box({
    flexDirection: "row",
    children: [
      el.Text({ children: [first ? "⏺ " : "  "] }),
      el.Box({ flexDirection: "column", flexShrink: 1, children: blocks }),
    ],
  });
}
