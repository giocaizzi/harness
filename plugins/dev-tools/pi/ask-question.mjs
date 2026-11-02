export function registerAskQuestionTool(pi) {
    const tool = {
        name: "ask_question",
        label: "Ask Question",
        description: "Ask the user a question interactively, optionally with multiple-choice options",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The question to ask the user",
                },
                options: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of choices for multiple-choice questions",
                },
            },
            required: ["question"],
        },
        async execute(_id, params, signal, _onUpdate, ctx) {
            if (process.env.GUARD_UNATTENDED === "1" || !ctx?.hasUI) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Unattended run (GUARD_UNATTENDED) / No UI: cannot ask questions interactively. Proceed with the recommended or default choice, or record the question in your report.",
                        },
                    ],
                    details: undefined,
                };
            }
            const rawTimeout = process.env.GUARD_ASK_TIMEOUT_MS;
            const askTimeoutMs = rawTimeout !== undefined && !Number.isNaN(Number(rawTimeout))
                ? Number(rawTimeout)
                : 60_000;
            const opts = {
                timeout: askTimeoutMs > 0 ? askTimeoutMs : undefined,
                signal,
            };
            let answer;
            if (params.options && params.options.length > 0) {
                answer = await ctx.ui?.select?.(params.question, params.options, opts);
            }
            else {
                answer = await ctx.ui?.input?.(params.question, undefined, opts);
            }
            if (answer !== undefined && answer !== null) {
                return {
                    content: [{ type: "text", text: answer }],
                    details: undefined,
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `No answer: nobody answered within ${String(askTimeoutMs > 0 ? askTimeoutMs / 1000 : 60)}s. Proceed with the default/recommended option or park the question in your report.`,
                    },
                ],
                details: undefined,
            };
        },
    };
    pi.registerTool(tool);
}
