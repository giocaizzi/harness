// Per-user shared stores (build, module and browser caches) that fill a disk: where each lives, how
// big it is, and the command that trims it. Report only: nothing here deletes.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { STORE_WALK_CAP } from "./constants.mjs";
function set(v) {
    return v === undefined || v === "" ? undefined : v;
}
function localAppData(i) {
    return set(i.env.LOCALAPPDATA) ?? join(i.home, "AppData", "Local");
}
export function userCacheDir(platform, env, home) {
    if (platform === "darwin")
        return join(home, "Library", "Caches");
    if (platform === "win32")
        return set(env.LOCALAPPDATA) ?? join(home, "AppData", "Local");
    return set(env.XDG_CACHE_HOME) ?? join(home, ".cache");
}
function userDataDir(i) {
    return set(i.env.XDG_DATA_HOME) ?? join(i.home, ".local", "share");
}
/** The first of: the env var, the tool's own answer, the OS default. */
function pick(envValue, probed, fallback) {
    return set(envValue) ?? probed() ?? fallback;
}
/** Resolve every store's path: env var, then the tool's own answer, then the OS default. */
export function resolveStores(i) {
    const { env, platform, home, probe } = i;
    const cache = userCacheDir(platform, env, home);
    const win = platform === "win32";
    const stores = [];
    const goCache = pick(env.GOCACHE, () => probe("go", ["env", "GOCACHE"]), join(cache, "go-build"));
    if (goCache !== "off")
        stores.push({
            id: "go-build",
            name: "Go build cache",
            path: goCache,
            trim: "go clean -cache",
            note: "safe: costs rebuild time",
        });
    const gopath = (set(env.GOPATH) ?? "").split(win ? ";" : ":").find(Boolean);
    stores.push({
        id: "go-mod",
        name: "Go module cache",
        path: pick(env.GOMODCACHE, () => probe("go", ["env", "GOMODCACHE"]), join(gopath ?? join(home, "go"), "pkg", "mod")),
        trim: "go clean -modcache",
        note: "when no go command runs; refetches over the network",
    });
    stores.push({
        id: "golangci-lint",
        name: "golangci-lint cache",
        path: set(env.GOLANGCI_LINT_CACHE) ?? join(cache, "golangci-lint"),
        trim: "golangci-lint cache clean",
        note: "safe",
    });
    stores.push({
        id: "envtest",
        name: "envtest binaries",
        path: platform === "darwin"
            ? join(home, "Library", "Application Support", "io.kubebuilder.envtest")
            : win
                ? join(localAppData(i), "kubebuilder-envtest")
                : join(userDataDir(i), "kubebuilder-envtest"),
        trim: "setup-envtest cleanup <version>",
        note: "versions no repo pins; not while tests run",
    });
    stores.push({
        id: "npm",
        name: "npm cache",
        path: pick(set(env.npm_config_cache) ?? env.NPM_CONFIG_CACHE, () => probe("npm", ["config", "get", "cache"]), win ? join(localAppData(i), "npm-cache") : join(home, ".npm")),
        trim: "npm cache verify",
        note: "garbage-collects; safe",
    });
    const pnpmHome = set(env.PNPM_HOME);
    const xdgData = set(env.XDG_DATA_HOME);
    const pnpmDefault = pnpmHome
        ? join(pnpmHome, "store")
        : xdgData
            ? join(xdgData, "pnpm", "store")
            : platform === "darwin"
                ? join(home, "Library", "pnpm", "store")
                : win
                    ? join(localAppData(i), "pnpm", "store")
                    : join(home, ".local", "share", "pnpm", "store");
    stores.push({
        id: "pnpm",
        name: "pnpm store",
        path: probe("pnpm", ["store", "path"]) ?? pnpmDefault,
        trim: "pnpm store prune",
        note: "when no install runs",
    });
    const pw = set(env.PLAYWRIGHT_BROWSERS_PATH);
    stores.push({
        id: "playwright",
        name: "Playwright browsers",
        path: pw && pw !== "0" ? pw : join(cache, "ms-playwright"),
        trim: "npx playwright uninstall",
        note: "in a project: its browsers; --all removes every installation's",
    });
    stores.push({
        id: "uv",
        name: "uv cache",
        path: pick(env.UV_CACHE_DIR, () => probe("uv", ["cache", "dir"]), 
        // uv uses the XDG layout on macOS too, not ~/Library/Caches.
        win
            ? join(localAppData(i), "uv", "cache")
            : join(set(env.XDG_CACHE_HOME) ?? join(home, ".cache"), "uv")),
        trim: "uv cache prune",
        note: "waits for running uv commands",
    });
    stores.push({
        id: "cargo",
        name: "Cargo registry",
        path: join(set(env.CARGO_HOME) ?? join(home, ".cargo"), "registry"),
        trim: "none",
        note: "Cargo cleans it itself (1.88+)",
    });
    stores.push({
        id: "sccache",
        name: "sccache",
        path: set(env.SCCACHE_DIR) ??
            (platform === "darwin"
                ? join(home, "Library", "Caches", "Mozilla.sccache")
                : win
                    ? join(localAppData(i), "Mozilla", "sccache")
                    : join(cache, "sccache")),
        trim: "none",
        note: "capped by SCCACHE_CACHE_SIZE",
    });
    stores.push({
        id: "docker",
        name: "Docker",
        path: undefined,
        trim: "docker builder prune --filter until=168h",
        note: "size: docker system df",
    });
    return stores;
}
/** Sum file sizes under path with lstat (symlinks are not followed); stops at the cap. */
export function storeSize(path) {
    try {
        lstatSync(path);
    }
    catch {
        return { exists: false, bytes: 0, capped: false };
    }
    let bytes = 0;
    let seen = 0;
    let capped = false;
    const stack = [path];
    for (let dir = stack.pop(); dir !== undefined && !capped; dir = stack.pop()) {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (++seen > STORE_WALK_CAP) {
                capped = true;
                break;
            }
            const full = join(dir, name);
            try {
                const st = lstatSync(full);
                if (st.isDirectory())
                    stack.push(full);
                else if (st.isFile())
                    bytes += st.size;
            }
            catch {
                // unreadable entry: skipped
            }
        }
    }
    return { exists: true, bytes, capped };
}
/** Free bytes for unprivileged users on the volume holding path, and the floor from HOST_DISK_FLOOR_GB. */
export function freeSpace(path, env) {
    const floor = Number(env.HOST_DISK_FLOOR_GB);
    const floorGb = set(env.HOST_DISK_FLOOR_GB) !== undefined &&
        Number.isFinite(floor) &&
        floor >= 0
        ? floor
        : 20;
    let bytes = Number.NaN;
    try {
        const s = statfsSync(path);
        bytes = s.bavail * s.bsize;
    }
    catch {
        // reported as unknown
    }
    return {
        path,
        bytes,
        floorBytes: floorGb * 1024 ** 3,
    };
}
/** Run a tool and return its trimmed stdout; undefined on any failure or empty output. */
export function makeProbe(platform) {
    return (cmd, args) => {
        const r = spawnSync(cmd, args, {
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
            shell: platform === "win32",
        });
        if (r.error || r.status !== 0)
            return undefined;
        const out = r.stdout.trim();
        return out === "" ? undefined : out;
    };
}
export function buildStoresReport(env, platform, home, probe) {
    const stores = resolveStores({
        env,
        platform,
        home,
        probe,
    }).map((s) => ({
        ...s,
        ...(s.path === undefined
            ? { exists: false, bytes: 0, capped: false }
            : storeSize(s.path)),
    }));
    stores.sort((a, b) => Number(b.exists) - Number(a.exists) || b.bytes - a.bytes);
    return { free: freeSpace(home, env), stores };
}
function gb(bytes) {
    return (bytes / 1024 ** 3).toFixed(1);
}
function size(bytes, capped) {
    const text = bytes >= 1024 ** 3
        ? `${gb(bytes)} GB`
        : `${(bytes / 1048576).toFixed(1)} MB`;
    return capped ? `>=${text}` : text;
}
export function renderStores(report) {
    const { free } = report;
    const floor = Math.round(free.floorBytes / 1024 ** 3);
    const lines = [
        `free: ${Number.isNaN(free.bytes) ? "unknown" : `${gb(free.bytes)} GB`} on ${free.path} (floor ${String(floor)} GB)${free.bytes < free.floorBytes ? ": below the floor" : ""}`,
    ];
    for (const s of report.stores) {
        const where = s.path ?? "not a host dir";
        lines.push(s.exists
            ? `${s.name} ${size(s.bytes, s.capped)} ${where}: trim with ${s.trim} (${s.note})`
            : s.path === undefined
                ? `${s.name} (${where}): trim with ${s.trim} (${s.note})`
                : `${s.name} absent (${where})`);
    }
    return lines;
}
