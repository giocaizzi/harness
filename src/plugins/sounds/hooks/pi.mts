// pi extension: sounds' turn and context alerts on pi's events. A finished run plays its clip and, after a minute or
// on an error, raises a notification (ctx.ui.notify); a run not aborted rings the terminal bell; the context crossing 80% and 90% raises one each. The clips and
// thresholds are the Claude plugin's defaults (pi has no per-plugin settings). Clips play with afplay, so on macOS only,
// as in Claude Code. Loaded from the root package.json.
import { settle } from "./alerts.mjs";
import { afplay, bell as ring } from "./play.mjs";
import type { AlertLevels, PiDependencies, PiExtensionApi } from "./types.mjs";

/** Register pi extension event handlers for sounds turn and context alerts. */
export default function soundsExtension(
  pi: PiExtensionApi,
  deps: PiDependencies = {},
): void {
  const play = deps.play ?? afplay;
  const bell = deps.bell ?? ring;
  let started = Date.now();
  let error = false;
  let levels: AlertLevels = {};
  pi.on("agent_start", () => {
    started = Date.now();
    error = false;
  });
  pi.on("message_end", (event) => {
    if (event.message?.stopReason === "error") error = true;
  });
  pi.on("session_compact", () => {
    levels = {};
  });
  pi.on("agent_settled", (event, ctx) => {
    const result = settle({
      durationMs: Date.now() - started,
      aborted: event.aborted,
      error,
      pct: ctx.getContextUsage?.()?.percent ?? null,
      before: levels,
    });
    levels = result.now;
    for (const clip of result.clips) play(clip);
    if (ctx.hasUI && !event.aborted) bell();
    if (ctx.hasUI) {
      for (const text of result.notices) ctx.ui.notify(text, "info");
    }
  });
}
