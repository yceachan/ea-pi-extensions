import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	GADGET_IDS,
	loadConfig,
	setGadgetStatus,
	type GadgetId,
	type GadgetStatus,
} from "./config.ts";

const USAGE =
	"Usage: /gadgets list | /gadgets enable [--global] <pkg> | /gadgets disable [--global] <pkg>";

function isGadgetId(value: string): value is GadgetId {
	return GADGET_IDS.includes(value as GadgetId);
}

export function completeArguments(prefix: string) {
	const trailingSpace = /\s$/.test(prefix);
	const words = prefix.trim() ? prefix.trim().split(/\s+/) : [];

	if (words.length === 0 || (words.length === 1 && !trailingSpace)) {
		const current = words[0] ?? "";
		const actions = ["list", "enable", "disable"].filter((action) =>
			action.startsWith(current),
		);
		return actions.length > 0
			? actions.map((action) => ({ value: action, label: action }))
			: null;
	}

	const action = words[0];
	if (action !== "enable" && action !== "disable") return null;

	const current = trailingSpace ? "" : (words.at(-1) ?? "");
	const completed = trailingSpace ? words : words.slice(0, -1);
	if (completed.length === 1 && current.startsWith("--")) {
		return "--global".startsWith(current)
			? [{ value: `${action} --global`, label: "--global" }]
			: null;
	}

	const global = completed.length === 2 && completed[1] === "--global";
	if (completed.length !== 1 && !global) return null;
	const values = GADGET_IDS.filter((id) => id.startsWith(current));
	if (values.length === 0) return null;
	return values.map((id) => ({
		value: [action, global ? "--global" : undefined, id]
			.filter(Boolean)
			.join(" "),
		label: id,
	}));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("gadgets", {
		description: USAGE,
		getArgumentCompletions: completeArguments,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const global = parts.includes("--global");
			const [action, pkg, ...extra] = parts.filter((part) => part !== "--global");

			if (action === "list" && !global && !pkg && extra.length === 0) {
				const config = loadConfig({ cwd: ctx.cwd });
				ctx.ui.notify(
					GADGET_IDS.map((id) => `${id}: ${config[id]}`).join("\n"),
					"info",
				);
				return;
			}

			if (
				(action !== "enable" && action !== "disable") ||
				!pkg ||
				extra.length > 0
			) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			if (!isGadgetId(pkg)) {
				ctx.ui.notify(`Unknown gadget: ${pkg}\n${USAGE}`, "error");
				return;
			}

			const status: GadgetStatus = action === "enable" ? "enabled" : "disabled";
			setGadgetStatus(pkg, status, { cwd: ctx.cwd, global });
			ctx.ui.notify(
				`${pkg}: ${status} (${global ? "global" : "project"}); reloading...`,
				"info",
			);
			await ctx.reload();
		},
	});
}
