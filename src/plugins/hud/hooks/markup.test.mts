import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cellWidth,
  escapeMd,
  inline,
  mark,
  STYLE,
  toTree,
  unmark,
} from "./markup.mjs";
import type { ElementBuilders } from "./markup.mjs";

interface TestNode {
  type: string;
  props: Record<string, unknown>;
  children?: unknown[];
}

const el: ElementBuilders = Object.fromEntries(
  ["Box", "Text", "Link", "Markdown"].map((type) => [
    type,
    ({ children, ...props }: Record<string, unknown>): TestNode => ({
      type,
      props,
      children: children as unknown[],
    }),
  ]),
) as unknown as ElementBuilders;

const pad = (s: string, n: number, how: unknown): string => {
  const gap = Math.max(0, n - cellWidth(s));
  const left =
    how === "center" ? Math.floor(gap / 2) : how === "flex-end" ? gap : 0;
  return " ".repeat(left) + s + " ".repeat(gap - left);
};

const draw = (n: unknown): string => {
  if (typeof n === "string") return n;
  const node = n as TestNode;
  if (node.type === "Markdown") return `md(${String(node.props.text)})`;
  const s = (node.children ?? [])
    .map(draw)
    .join(
      node.type === "Box" && node.props.flexDirection === "column" ? "\n" : "",
    );
  return node.type === "Box" && typeof node.props.width === "number"
    ? pad(s, node.props.width, node.props.justifyContent)
    : s;
};

void test("mark and unmark; colour off writes the text alone", () => {
  assert.equal(unmark(`a ${mark("ok", "b")} c`), "a b c");
  assert.equal(mark("ok", "b", false), "b");
  assert.equal(mark("ok", ""), "");
  assert.equal(escapeMd("a[b]_c*"), "a\\[b\\]\\_c\\*");
});

void test("inline: marked spans styled, links with styled labels, code, bold, italic, escapes", () => {
  const out = inline(
    `x ${mark("ok", "✓ passed")} [${mark("dim", "r › ")}${mark("name", "a\\_b.ts")}](vscode://file/a_b.ts) \`c\` **b** *i* \\[w\\]`,
    el,
  ) as TestNode[];
  assert.equal(out[0], "x ");
  assert.deepEqual(out[1], {
    type: "Text",
    props: STYLE.ok,
    children: ["✓ passed"],
  });
  const out3 = out[3];
  assert.ok(out3);
  assert.equal(out3.type, "Link");
  assert.equal(out3.props.href, "vscode://file/a_b.ts");
  const linkKids = out3.children as TestNode[];
  assert.deepEqual(
    linkKids.map((c) => (c.children as string[])[0]),
    ["r › ", "a_b.ts"],
  );
  assert.equal((out[5]?.children as string[])[0], "c");
  assert.equal(out[7]?.props.bold, true);
  assert.equal(out[9]?.props.italic, true);
  assert.equal(out.at(-1), " [w]");
});

void test("toTree: null without a mark; marked lines are rows, the rest the engine Markdown", () => {
  assert.equal(toTree("plain [a](vscode://x) text", el), null);
  const text = [
    "# Title",
    "",
    "Some **prose**.",
    "More prose.",
    "",
    `- lint: ${mark("ok", "✓ passed")}`,
    "- docs",
    "",
    "```",
    `code x`,
    "```",
    "",
    `> quote ${mark("bad", "x")}`,
  ].join("\n");
  const t = toTree(text, el, { first: true }) as TestNode;
  const tKids = t.children as TestNode[];
  assert.equal((tKids[0]?.children as string[])[0], "⏺ ");
  assert.equal(
    draw(tKids[1]),
    [
      "md(# Title\n\nSome **prose**.\nMore prose.)",
      " ",
      "- lint: ✓ passed",
      "md(- docs\n\n```\ncode x\n```)",
      " ",
      "▎ quote x",
    ].join("\n"),
  );
  const t2 = toTree(mark("ok", "x"), el) as TestNode;
  const t2Kids = t2.children as TestNode[];
  assert.equal((t2Kids[0]?.children as string[])[0], "  ");
});

void test("cellWidth: wide characters and emoji two, combining marks and joiners none", () => {
  assert.equal(cellWidth("abc"), 3);
  assert.equal(cellWidth("日本"), 4);
  assert.equal(cellWidth("✅ ok"), 5);
  assert.equal(cellWidth("✔️"), 2);
  assert.equal(cellWidth("e\u0301"), 1);
  assert.equal(cellWidth("✓ ✗ ⊘"), 5);
});

const T = (...rows: string[]): string => rows.join("\n");

void test("toTree: a table with a mark is drawn in colour, its columns as wide as their widest cell", () => {
  const t = toTree(
    T(
      "| check | result |",
      "|---|---|",
      `| lint | ${mark("ok", "✓")} |`,
      `| \`e2e\` | ${mark("bad", "✗ failed")} |`,
      "| 日本 | *slow* |",
    ),
    el,
  ) as TestNode;
  const tKids = t.children as TestNode[];
  assert.equal(
    draw(tKids[1]),
    T(
      "┌───────┬──────────┐",
      "│ check │ result   │",
      "├───────┼──────────┤",
      "│ lint  │ ✓        │",
      "│ e2e   │ ✗ failed │",
      "│ 日本  │ slow     │",
      "└───────┴──────────┘",
    ),
  );
  const container = tKids[1];
  assert.ok(container);
  const containerKids = container.children as TestNode[];
  const cell = (r: number, c: number): TestNode => {
    const rowNode = containerKids[r];
    assert.ok(rowNode);
    const rowKids = rowNode.children as TestNode[];
    const box = rowKids[1 + 2 * c];
    assert.ok(box);
    const cellNode = (box.children as TestNode[])[0];
    assert.ok(cellNode);
    return cellNode;
  };
  const cell31 = (cell(3, 1).children as TestNode[])[0];
  assert.ok(cell31);
  assert.deepEqual(cell31.props, STYLE.ok);
  const cell10 = (cell(1, 0).children as TestNode[])[0];
  assert.ok(cell10);
  assert.equal(cell10.props.bold, true);
  const row3 = containerKids[3];
  assert.ok(row3);
  const row3Kids = row3.children as TestNode[];
  assert.equal(row3Kids[1]?.props.width, 5);
});

void test("toTree: a table keeps its links and its alignment, and is recognised without the leading pipe", () => {
  const t = toTree(
    T(
      "| file | n |",
      "|:-:|--:|",
      `| [${mark("name", "a.ts")}](vscode://file/a.ts) | 1 |`,
    ),
    el,
  ) as TestNode;
  const tKids = t.children as TestNode[];
  assert.equal(
    draw(tKids[1]),
    T(
      "┌──────┬───┐",
      "│ file │ n │",
      "├──────┼───┤",
      "│ a.ts │ 1 │",
      "└──────┴───┘",
    ),
  );
  const container = tKids[1];
  assert.ok(container);
  const containerKids = container.children as TestNode[];
  const row3 = containerKids[3];
  assert.ok(row3);
  const row3Kids = row3.children as TestNode[];
  const cell0 = (row3Kids[1]?.children as TestNode[])[0];
  assert.ok(cell0);
  const link = (cell0.children as TestNode[])[0];
  assert.ok(link);
  assert.equal(link.type, "Link");
  assert.equal(link.props.href, "vscode://file/a.ts");
  assert.equal(row3Kids[3]?.props.justifyContent, "flex-end");
  const t2 = toTree(
    T("a | b", "--- | ---", `lint | ${mark("bad", "✗")}`),
    el,
  ) as TestNode;
  const t2Kids = t2.children as TestNode[];
  assert.equal(
    draw(t2Kids[1]),
    T(
      "┌──────┬───┐",
      "│ a    │ b │",
      "├──────┼───┤",
      "│ lint │ ✗ │",
      "└──────┴───┘",
    ),
  );
});

void test("toTree: a table wider than the viewport fits it, the widest column wrapping at spaces, a long word split", () => {
  const text = T(
    "| id | note |",
    "|---|---|",
    `| ${mark("ok", "1")} | a long note that will not fit | `,
    "| 2 | path/to/a/very/long/file.ts |",
  );
  const t = toTree(text, el, { columns: 30 }) as TestNode;
  const tKids = t.children as TestNode[];
  const lines = draw(tKids[1]).split("\n");
  for (const l of lines) assert.equal(cellWidth(l), 28, l);
  assert.deepEqual(lines, [
    "┌────┬─────────────────────┐",
    "│ id │ note                │",
    "├────┼─────────────────────┤",
    "│ 1  │ a long note that    │",
    "│    │ will not fit        │",
    "│ 2  │ path/to/a/very/long │",
    "│    │ /file.ts            │",
    "└────┴─────────────────────┘",
  ]);
  const tNoCol = toTree(text, el) as TestNode;
  const tNoColKids = tNoCol.children as TestNode[];
  assert.equal(draw(tNoColKids[1]).split("\n").length, 6);
});

void test("toTree: a table without a mark stays the engine Markdown", () => {
  const t = toTree(`${mark("ok", "x")}\n\n| a |\n|---|\n| b |`, el) as TestNode;
  const tKids = t.children as TestNode[];
  assert.equal(draw(tKids[1]), "x\n \nmd(| a |\n|---|\n| b |)");
});
