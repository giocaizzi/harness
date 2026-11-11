// Tests for `repo-sweep.mjs --stores` (plugins/dev-tools/skills/host-hygiene/scripts/stores.mjs): the pure
// path resolution per platform, and the real CLI in a temp cwd that is not a git repo. No POSIX shell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveStores } from "../plugins/dev-tools/skills/host-hygiene/scripts/stores.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/dev-tools/skills/host-hygiene/scripts/repo-sweep.mjs", import.meta.url));
const none = () => undefined;
const HOME = join("/", "h");

const paths = (platform, env = {}, probe = none) =>
  Object.fromEntries(resolveStores({ env, platform, home: HOME, probe }).map((s) => [s.id, s.path]));

describe("resolveStores defaults", () => {
  test("darwin", () => {
    const p = paths("darwin");
    assert.equal(p["go-build"], join(HOME, "Library/Caches/go-build"));
    assert.equal(p["go-mod"], join(HOME, "go/pkg/mod"));
    assert.equal(p["golangci-lint"], join(HOME, "Library/Caches/golangci-lint"));
    assert.equal(p.envtest, join(HOME, "Library/Application Support/io.kubebuilder.envtest"));
    assert.equal(p.npm, join(HOME, ".npm"));
    assert.equal(p.pnpm, join(HOME, "Library/pnpm/store"));
    assert.equal(p.playwright, join(HOME, "Library/Caches/ms-playwright"));
    assert.equal(p.uv, join(HOME, "Library/Caches/uv"));
    assert.equal(p.cargo, join(HOME, ".cargo/registry"));
    assert.equal(p.sccache, join(HOME, "Library/Caches/Mozilla.sccache"));
    assert.equal(p.docker, undefined);
  });

  test("linux", () => {
    const p = paths("linux");
    assert.equal(p["go-build"], join(HOME, ".cache/go-build"));
    assert.equal(p.envtest, join(HOME, ".local/share/kubebuilder-envtest"));
    assert.equal(p.pnpm, join(HOME, ".local/share/pnpm/store"));
    assert.equal(p.playwright, join(HOME, ".cache/ms-playwright"));
    assert.equal(p.uv, join(HOME, ".cache/uv"));
    assert.equal(p.sccache, join(HOME, ".cache/sccache"));
    const x = paths("linux", { XDG_CACHE_HOME: "/xc", XDG_DATA_HOME: "/xd" });
    assert.equal(x["go-build"], join("/xc", "go-build"));
    assert.equal(x.envtest, join("/xd", "kubebuilder-envtest"));
    assert.equal(x.pnpm, join("/xd", "pnpm/store"));
  });

  test("win32", () => {
    const local = join(HOME, "AppData", "Local");
    const p = paths("win32");
    assert.equal(p["go-build"], join(local, "go-build"));
    assert.equal(p.envtest, join(local, "kubebuilder-envtest"));
    assert.equal(p.npm, join(local, "npm-cache"));
    assert.equal(p.pnpm, join(local, "pnpm/store"));
    assert.equal(p.playwright, join(local, "ms-playwright"));
    assert.equal(p.uv, join(local, "uv/cache"));
    assert.equal(p.sccache, join(local, "Mozilla/sccache"));
    assert.equal(paths("win32", { LOCALAPPDATA: "/la" }).uv, join("/la", "uv/cache"));
  });
});

describe("resolveStores precedence", () => {
  test("env beats probe, probe beats default", () => {
    const probe = (cmd, args) => `/probed/${cmd}-${args.join("-")}`;
    const p = paths("linux", { GOCACHE: "/e/gocache", npm_config_cache: "/e/npm" }, probe);
    assert.equal(p["go-build"], "/e/gocache");
    assert.equal(p.npm, "/e/npm");
    assert.equal(p["go-mod"], "/probed/go-env-GOMODCACHE");
    assert.equal(p.uv, "/probed/uv-cache-dir");
    assert.equal(p.pnpm, "/probed/pnpm-store-path");
    assert.equal(paths("linux", { NPM_CONFIG_CACHE: "/e/n2" }, probe).npm, "/e/n2");
  });

  test("GOPATH, CARGO_HOME, PNPM_HOME, SCCACHE_DIR, GOLANGCI_LINT_CACHE", () => {
    const p = paths("linux", {
      GOPATH: "/gp1:/gp2",
      CARGO_HOME: "/ch",
      PNPM_HOME: "/ph",
      SCCACHE_DIR: "/sc",
      GOLANGCI_LINT_CACHE: "/gl",
    });
    assert.equal(p["go-mod"], join("/gp1", "pkg/mod"));
    assert.equal(p.cargo, join("/ch", "registry"));
    assert.equal(p.pnpm, join("/ph", "store"));
    assert.equal(p.sccache, "/sc");
    assert.equal(p["golangci-lint"], "/gl");
  });

  test("GOCACHE=off drops the Go build store; PLAYWRIGHT_BROWSERS_PATH=0 is ignored", () => {
    const stores = resolveStores({ env: { GOCACHE: "off", PLAYWRIGHT_BROWSERS_PATH: "0" }, platform: "linux", home: HOME, probe: none });
    assert.ok(!stores.some((s) => s.id === "go-build"));
    assert.equal(stores.find((s) => s.id === "playwright").path, join(HOME, ".cache/ms-playwright"));
    const custom = paths("linux", { PLAYWRIGHT_BROWSERS_PATH: "/pw" });
    assert.equal(custom.playwright, "/pw");
  });
});

describe("--stores CLI", () => {
  let root;
  let cwd;
  let env;
  const files = [];

  function put(dir, name, bytes) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, Buffer.alloc(bytes, 1));
    files.push(file);
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "stores-"));
    cwd = join(root, "cwd");
    const home = join(root, "home");
    const empty = join(root, "empty-path");
    for (const d of [cwd, home, empty]) mkdirSync(d, { recursive: true });
    put(join(root, "gocache"), "a", 3000);
    put(join(root, "gocache", "sub"), "b", 2000);
    put(join(root, "uv"), "c", 1000);
    put(join(home, ".npm"), "d", 500);
    env = {
      PATH: empty,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(root, "local"),
      XDG_CACHE_HOME: join(root, "xc"),
      XDG_DATA_HOME: join(root, "xd"),
      GOCACHE: join(root, "gocache"),
      UV_CACHE_DIR: join(root, "uv"),
      SystemRoot: process.env.SystemRoot ?? "",
    };
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const stores = (args) => spawnSync(process.execPath, [SCRIPT, "--stores", ...args], { cwd, env, encoding: "utf8", timeout: 60000 });

  test("--json reports sizes and absent stores, and deletes nothing", () => {
    const r = stores(["--json"]);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.ok(rep.free.bytes > 0);
    assert.equal(rep.free.floorBytes, 20 * 1024 ** 3);
    const by = Object.fromEntries(rep.stores.map((s) => [s.id, s]));
    assert.equal(by["go-build"].bytes, 5000);
    assert.equal(by["go-build"].exists, true);
    assert.equal(by["go-build"].capped, false);
    assert.equal(by.uv.bytes, 1000);
    assert.equal(by.npm.bytes, 500);
    assert.equal(by["go-build"].trim, "go clean -cache");
    assert.equal(by.sccache.exists, false);
    assert.equal(by.docker.exists, false);
    assert.equal(by.docker.path, undefined);
    assert.deepEqual(rep.stores.slice(0, 3).map((s) => s.id), ["go-build", "uv", "npm"]);
    for (const f of files) assert.ok(existsSync(f), f);
  });

  test("text mode prints the free line and one line per store", () => {
    const r = stores([]);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0], /^free: \d+\.\d GB on .+ \(floor 20 GB\)/);
    assert.equal(lines.length, 1 + 11);
    assert.ok(lines.some((l) => l.startsWith("Go build cache 0.0 MB") && l.includes("trim with go clean -cache")));
    assert.ok(lines.some((l) => l.startsWith("sccache absent (")));
  });

  test("HOST_DISK_FLOOR_GB above free space says below the floor", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--stores"], { cwd, env: { ...env, HOST_DISK_FLOOR_GB: "99999999" }, encoding: "utf8", timeout: 60000 });
    assert.match(r.stdout.split("\n")[0], /: below the floor$/);
  });

  for (const flag of [["--apply"], ["--auto"], ["--remote-scope", "all"]]) {
    test(`${flag.join(" ")} is a usage error`, () => {
      const r = stores(flag);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage:/);
    });
  }
});
