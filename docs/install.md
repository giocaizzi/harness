# Install, update and verify

Runbook for every supported harness. What each one gets: [compatibility.md](compatibility.md). The hooks need `node` 22+ on PATH; everything works on macOS, Linux and Windows.

Plugins: `api`, `python`, `go`, `javascript`, `dev-tools`, `guard`, `hud`, `sounds`, `factory` (`hud` does something in Claude Code and pi, its status line also in Copilot CLI, running subagents in opencode; `sounds` in Claude Code, pi, Codex and opencode). `factory` needs `dev-tools` and `guard`: Claude Code installs them with it, the other harnesses need them installed too.

## Claude Code

```bash
claude plugin marketplace add giocaizzi/harness
claude plugin install dev-tools@giocaizzi-harness   # and api, python, go, javascript, guard, hud, sounds, factory
```

Update: `claude plugin marketplace update giocaizzi-harness`; an installed plugin updates when its version changes. Check: `/plugin` lists them, `/agents` shows `scout`. Old versions stay in the plugin cache: `sweep-stale.sh --plugins` (dev-tools `host-hygiene`) lists them, and keeps any version a session started before the update may still run. It covers every marketplace in the cache; add `--marketplace giocaizzi-harness` to leave other marketplaces' plugins alone. Once every open session ran `/reload-plugins`, `sweep-stale.sh --plugins --marketplace giocaizzi-harness --after-reload --apply` removes this marketplace's old versions.

## GitHub Copilot CLI

```bash
copilot plugin marketplace add giocaizzi/harness
copilot plugin install dev-tools@giocaizzi-harness
```

Update: `copilot plugin marketplace update giocaizzi-harness`. Check: `copilot plugin list`, `/agent` shows `scout`.

## VS Code Copilot

Settings (`chat.plugins.enabled` on): `"chat.plugins.marketplaces": ["giocaizzi/harness"]`, then install from `@agentPlugins` in the Extensions view or **Chat: Install Plugin From Source**. Hooks need `chat.useHooks`. Check: **Chat: Open Agent Customizations**. VS Code also loads plugins Copilot CLI installed.

## Codex CLI

Plugins (skills, the guard's hooks and sounds' Stop hook) come from the marketplace; agents from a checkout, since Codex plugins carry none.

```bash
codex plugin marketplace add giocaizzi/harness
codex plugin add dev-tools@giocaizzi-harness        # and api, python, go, javascript, guard, sounds, factory
git clone https://github.com/giocaizzi/harness ~/.local/share/giocaizzi-harness
make -C ~/.local/share/giocaizzi-harness install HARNESS=codex   # agents -> ~/.codex/agents, guard prompt rules -> ~/.codex/rules ($CODEX_HOME)
```

The prompt rules (`rules/giocaizzi-guard.rules`) make Codex itself ask before a plain risky command (`rm -rf build`, `git reset --hard`); without them, when they are older than the installed guard, or when the session's approvals go to Codex's AI reviewer (`approvals_reviewer`, `--approve-for-me`), the guard denies those commands instead.

Then trust the guard's and sounds' hooks once per version: `/hooks` in a Codex session, review, trust. Untrusted plugin hooks are skipped.

Update: `codex plugin marketplace upgrade`, then `git -C ~/.local/share/giocaizzi-harness pull` and the `make install` line again. Check: `codex plugin list` shows the plugins installed; `codex debug prompt-input hi` lists `dev-tools:*` skills; in a uv project, asking Codex to run `pip install x` is blocked with "This repo uses uv"; asking it to run `rm -rf build` shows Codex's approval prompt with "guard: recursive delete".

## opencode

opencode has no plugin marketplace, so everything comes from a checkout:

```bash
git clone https://github.com/giocaizzi/harness ~/.local/share/giocaizzi-harness
make -C ~/.local/share/giocaizzi-harness install HARNESS=opencode
```

That copies the skills to `~/.config/opencode/skills/`, the agents to `~/.config/opencode/agents/`, and writes `~/.config/opencode/plugins/giocaizzi-guard.js` and `giocaizzi-sounds.js`, stubs that load `plugins/guard/hooks/opencode.mjs` and `plugins/sounds/hooks/opencode.mjs` from the checkout, and adds hud's TUI plugin (`plugins/hud/hooks/opencode-tui.mjs`) to the `plugin` list of `~/.config/opencode/tui.json`, keeping the rest of that file (one with comments is left alone, with the entry to add printed) (`$XDG_CONFIG_HOME` moves all of them). A skill or agent of the same name already there is replaced; the installer records what it wrote in `.giocaizzi-harness.json` and removes what a later run no longer ships.

Update: `git pull` in the checkout (the guard updates with it), then the `make install` line again for skills and agents. Check: `opencode debug skill` lists `ship`; `opencode agent list` shows `scout`.

## pi

```bash
pi install git:github.com/giocaizzi/harness
```

pi reads the repo's `package.json`: every plugin's skills and four extensions: the guard, a `subagent` tool that runs `scout`, `driver`, `reviewer`, `escalate`, `api-reviewer` and `verifier` in their own pi sessions, hud's footer and sounds' alerts. Update: `pi update --extensions`. Check: `pi list` shows the package; `/skill:ship` loads a skill; asking for a scout runs the `subagent` tool.

## Antigravity

```bash
git clone https://github.com/giocaizzi/harness ~/.local/share/giocaizzi-harness
make -C ~/.local/share/giocaizzi-harness install HARNESS=antigravity
```

That copies the skills to `~/.gemini/config/skills/`, the agents to `~/.gemini/config/agents/`, and registers the guard's `PreToolUse` hook (for `run_command` with native `ask`/`deny` decisions) and `Stop` hook into `~/.gemini/config/hooks.json` (`$GEMINI_CONFIG_DIR` moves all of them).

Update: `git pull` in the checkout, then `make install HARNESS=antigravity` again. Check: `/agents` shows `scout`; running `pip install x` in a uv repo is denied with the guard's reason.

## From a checkout (development)

```bash
claude --plugin-dir ./plugins/guard                      # Claude Code, one plugin
copilot plugin marketplace add "$PWD"                    # Copilot CLI, then install <plugin>@giocaizzi-harness
codex plugin marketplace add "$PWD"                      # Codex, then codex plugin add <plugin>@giocaizzi-harness
make install                                             # Codex agents, opencode skills/agents/guard, Antigravity
pi install "$PWD"                                        # pi, loads the checkout in place
```

VS Code: `"chat.pluginLocations": { "/abs/path/plugins/guard": true }`.

To try one without touching your own config, give the harness a throwaway home: `CODEX_HOME`, `COPILOT_HOME`, `XDG_CONFIG_HOME` (opencode), `PI_CODING_AGENT_DIR` (pi). `make e2e` does exactly that for Copilot CLI, Codex, opencode and pi.

## Verify

```bash
make check   # manifests, generated files, skills, README sync, harness parity, node tests, `claude plugin test`
make e2e     # Copilot CLI, Codex, opencode, pi against a scripted model; no login needed
```

`make e2e` skips a CLI that is not on `PATH`. To run all four without a global install, let `npx` fetch them into its cache and put them on `PATH` for one run:

```bash
npx -y -p @github/copilot -p @openai/codex -p opencode-ai -p @earendil-works/pi-coding-agent -c "make e2e"
```
