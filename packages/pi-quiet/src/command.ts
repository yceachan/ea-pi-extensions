/**
 * /quiet command parsing and status text.
 * Sticky Preference changes are pure here; the extension persists them.
 */

export type QuietCommand =
	| { action: "toggle" }
	| { action: "on" }
	| { action: "off" }
	| { action: "status" }
	| { action: "help" }
	| { action: "unknown"; token: string };

export type QuietCommandResult = {
	enabled: boolean;
	changed: boolean;
	kind: "set" | "status" | "help";
};

export function parseQuietCommand(args: string): QuietCommand {
	const trimmed = (args ?? "").trim();
	if (!trimmed) return { action: "toggle" };

	const lower = trimmed.toLowerCase();
	if (lower === "on") return { action: "on" };
	if (lower === "off") return { action: "off" };
	if (lower === "status") return { action: "status" };
	if (lower === "help") return { action: "help" };

	return { action: "unknown", token: trimmed };
}

/**
 * Apply a parsed command to the current Sticky Preference.
 * Does not touch disk.
 */
export function applyQuietCommand(cmd: QuietCommand, currentlyEnabled: boolean): QuietCommandResult {
	switch (cmd.action) {
		case "toggle": {
			const enabled = !currentlyEnabled;
			return { enabled, changed: true, kind: "set" };
		}
		case "on":
			return {
				enabled: true,
				changed: currentlyEnabled !== true,
				kind: "set",
			};
		case "off":
			return {
				enabled: false,
				changed: currentlyEnabled !== false,
				kind: "set",
			};
		case "status":
			return { enabled: currentlyEnabled, changed: false, kind: "status" };
		case "help":
		case "unknown":
			return { enabled: currentlyEnabled, changed: false, kind: "help" };
	}
}

export function formatQuietStatus(enabled: boolean, configPath: string): string {
	const mode = enabled ? "Quiet Display (on)" : "Stock Display (off)";
	return `Display: ${mode}\nConfig: ${configPath}\nExpanding a tool row does not change this preference.`;
}

export function formatQuietHelp(configPath?: string): string {
	const lines = [
		"Usage: /quiet [on|off|status|help]",
		"",
		"  (no args)  Toggle Quiet Display",
		"  on         Quiet Display (dense tool rows)",
		"  off        Stock Display (pi's normal tool UI)",
		"  status     Show Sticky Preference and config path",
		"  help       Show this help",
		"",
		"Default when installed: Quiet Display on.",
		"Momentary expand does not change the Sticky Preference.",
		"Toggle applies to new tool rows only (scrollback unchanged).",
	];
	if (configPath) {
		lines.push("", `Config: ${configPath}`);
	}
	return lines.join("\n");
}
