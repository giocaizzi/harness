// opencode plugin: sounds' turn and context alerts on opencode's events (https://opencode.ai/docs/plugins/). When a
// session goes idle it plays the default clip for how the turn ended (macOS only) and shows the notices as TUI toasts
// (`client.tui.showToast`); a permission prompt, a question and a finished main turn ring the terminal bell. The context is the last assistant message's tokens over the model's context limit.
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file, so it exports
// nothing but the plugin (opencode calls every exported function as one).
import { CLIPS, settle } from "./alerts.mjs";
import { afplay, bell as ring } from "./play.mjs";
import type {
  AlertLevels,
  OpencodeClient,
  OpencodeDependencies,
  OpencodeEventInfo,
  OpencodeHooks,
} from "./types.mjs";

/** Create the opencode sounds plugin handlers for chat messages and session events. */
export const SoundsPlugin = (
  { client }: { client: OpencodeClient },
  deps: OpencodeDependencies = {},
): Promise<OpencodeHooks> => {
  const play = deps.play ?? afplay;
  const bell = deps.bell ?? ring;
  const now = deps.now ?? Date.now;
  const started = new Map<string, number>(); // sessionID -> when its last prompt was sent
  const errors = new Map<string, string>(); // sessionID -> the error name that ended its turn
  const last = new Map<string, OpencodeEventInfo>(); // sessionID -> its last assistant message
  const levels = new Map<string, AlertLevels>(); // sessionID -> context levels raised so far
  const children = new Set<string>(); // subagent sessions
  let limits: Promise<Record<string, number | undefined>> | undefined; // `${providerID}/${modelID}` -> context window, read once
  const contextOf = async (
    message: OpencodeEventInfo,
  ): Promise<number | undefined> => {
    limits ??= client.config
      .providers()
      .then((response) =>
        Object.fromEntries(
          (response.data?.providers ?? []).flatMap((provider) =>
            Object.values(provider.models ?? {}).map(
              (model): [string, number | undefined] => [
                `${provider.id}/${model.id}`,
                model.limit?.context,
              ],
            ),
          ),
        ),
      )
      .catch((): Record<string, number | undefined> => ({}));
    return (await limits)[
      `${message.providerID ?? ""}/${message.modelID ?? ""}`
    ];
  };

  return Promise.resolve({
    "chat.message": ({ sessionID }): Promise<void> => {
      started.set(sessionID, now());
      errors.delete(sessionID);
      return Promise.resolve();
    },
    event: async ({ event }): Promise<void> => {
      const properties = event.properties ?? {};
      if (
        event.type === "permission.asked" ||
        event.type === "question.asked"
      ) {
        const clip = CLIPS.soundNeedsInput;
        if (clip !== null) play(clip);
        bell();
      } else if (
        event.type === "session.created" &&
        properties.info?.parentID &&
        properties.info.id
      ) {
        children.add(properties.info.id);
      } else if (
        event.type === "message.updated" &&
        properties.info?.role === "assistant" &&
        properties.info.sessionID
      ) {
        last.set(properties.info.sessionID, properties.info);
      } else if (event.type === "session.error" && properties.sessionID) {
        errors.set(
          properties.sessionID,
          properties.error?.name ?? "UnknownError",
        );
      } else if (event.type === "session.idle" && properties.sessionID) {
        const id = properties.sessionID;
        const message = last.get(id);
        const tokens = message?.tokens;
        const limit = message ? await contextOf(message) : undefined;
        const used = tokens
          ? tokens.input +
            tokens.output +
            tokens.reasoning +
            tokens.cache.read +
            tokens.cache.write
          : 0;
        const err = errors.get(id);
        const result = settle({
          durationMs: now() - (started.get(id) ?? now()),
          aborted: err === "MessageAbortedError",
          error: Boolean(err) && err !== "MessageAbortedError",
          agentId: children.has(id) ? id : undefined,
          pct: limit ? Math.round((used / limit) * 100) : null,
          before: levels.get(id) ?? {},
        });
        levels.set(id, result.now);
        errors.delete(id);
        for (const clip of result.clips) play(clip);
        if (!children.has(id) && err !== "MessageAbortedError") bell();
        for (const notice of result.notices) {
          void client.tui
            .showToast({ body: { message: notice, variant: "info" } })
            .catch(() => {
              // Ignore TUI toast failures.
            });
        }
      }
    },
  });
};
