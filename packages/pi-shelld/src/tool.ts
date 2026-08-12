import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import { type Static, Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getShell,
	listShells,
	registerShell,
	spawnShell,
	stateDir,
	stopShell,
	closeShell,
	withRegistryLock,
} from "./shells";

/**
 * pi-shelld agent-facing tool (wayfinder ticket T1, lifecycle per ADR-0001).
 *
 * One tool, six actions. Single-tool-with-action keeps the LLM's tool table
 * small (one entry in `Available tools` instead of six) and the state model
 * obvious: every action operates on the same session-scoped shell registry
 * (see `src/shells.ts`).
 *
 * Lifecycle (ADR-0001): shells read as `running` (pid alive) or
 * `to close` (pid dead, derived). `stop` kills the tree but keeps the
 * record + log for a final read; `close` kills, deletes the log and
 * removes the record (irreversible). Every shell dies with the session.
 *
 * Truncation policy: LLM-facing output is bounded — `logs` tails the log
 * file through `truncateTail` (line + byte limits, defaults 50 lines and
 * `DEFAULT_MAX_BYTES`); `ps`/`status` emit only registry fields.
 */

const shellDaemonParams = Type.Object({
	action: StringEnum(["start", "ps", "status", "logs", "stop", "close"], {
		description:
			"Operation to perform: start a background shell, list the session's shells (ps), show one shell's status, tail one shell's logs, stop a shell (kill the process tree, keep record + log), or close a shell (kill, delete its log, and remove it — irreversible).",
	}),
	command: Type.Optional(
		Type.String({
			description:
				'Shell command line to run (required for action=start). Example: "npm run dev".',
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the command. Defaults to the current session cwd.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Optional short label for the shell; shown in the ps list and in the ⭕shell monitor.",
		}),
	),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description:
				"Optional extra environment variables for the spawned process (merged over the session environment).",
		}),
	),
	shellId: Type.Optional(
		Type.String({
			description:
				"Shell id, as returned by start or ps (required for status, logs, stop, close).",
		}),
	),
	lines: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description:
				"How many tail lines to return for action=logs (default 50).",
		}),
	),
});
type ShellDaemonParams = Static<typeof shellDaemonParams>;

/** Resolve the shellId parameter, throwing the same style of error for both missing and unknown ids. */
function requireShell(shellId: string | undefined) {
	if (!shellId) {
		throw new Error(
			"shell_daemon: this action requires a `shellId` parameter (see action=ps for live ids)",
		);
	}
	const shell = getShell(shellId);
	if (!shell) {
		throw new Error(
			`shell_daemon: unknown shellId "${shellId}" (see action=ps for live ids)`,
		);
	}
	return shell;
}

async function executeShellDaemon(
	_toolCallId: string,
	params: ShellDaemonParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	switch (params.action) {
		case "start": {
			if (!params.command) {
				throw new Error(
					"shell_daemon: action=start requires a `command` parameter",
				);
			}
			const cwd = params.cwd ?? ctx.cwd;
			const spawned = spawnShell({
				command: params.command,
				cwd,
				env: params.env,
				name: params.name,
			});
			const record = {
				id: spawned.id,
				name: params.name,
				command: params.command,
				cwd,
				pid: spawned.pid,
				status: "running" as const,
				startedAt: spawned.startedAt,
				logFile: spawned.logFile,
			};
			// Serialize registry writes against concurrent tool calls (see
			// withRegistryLock in shells.ts).
			await withRegistryLock(() => registerShell(record));
			const text = [
				`Started shell ${spawned.id} (pid ${spawned.pid}, status running).`,
				`Command: ${params.command}`,
				`Cwd: ${cwd}`,
				`Log: ${spawned.logFile}`,
				`State dir: ${stateDir()}`,
				"Check it with shell_daemon action=ps / status / logs; stop it with action=stop or close it with action=close when done.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					id: spawned.id,
					pid: spawned.pid,
					status: "running",
					logFile: spawned.logFile,
				},
			};
		}
		case "ps": {
			const shells = listShells();
			const rows =
				shells.length === 0
					? ["  (no shells for this session)"]
					: shells.map((s) => {
							const name = s.name ? `[${s.name}] ` : "";
							const note = s.stoppedBy ? ` (stopped by ${s.stoppedBy})` : "";
							return `  ${s.status.padEnd(8)} ${s.id.slice(0, 8)} ${name}${s.command} (pid ${s.pid})${note}`;
						});
			const text = [
				`${shells.length} shell(s) — state dir: ${stateDir()} (status is derived from pid liveness)`,
				...rows,
			].join("\n");
			return { content: [{ type: "text", text }], details: { shells } };
		}
		case "status": {
			const shell = requireShell(params.shellId);
			const text = [
				`Shell ${shell.id}`,
				`  name:      ${shell.name ?? "-"}`,
				`  status:    ${shell.status}`,
				`  pid:       ${shell.pid}`,
				`  command:   ${shell.command}`,
				`  cwd:       ${shell.cwd}`,
				`  startedAt: ${new Date(shell.startedAt).toISOString()}`,
				`  stoppedBy: ${shell.stoppedBy ?? "-"}`,
				`  logFile:   ${shell.logFile}`,
			].join("\n");
			return { content: [{ type: "text", text }], details: { shell } };
		}
		case "logs": {
			const shell = requireShell(params.shellId);
			let raw: string;
			try {
				raw = fs.readFileSync(shell.logFile, "utf8");
			} catch {
				raw = "";
			}
			const tail = truncateTail(raw, {
				maxLines: params.lines ?? 50,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			const text = [
				`Shell ${shell.id} — ${shell.status} (pid ${shell.pid})`,
				`Showing ${tail.outputLines} of ${tail.totalLines} lines (${formatSize(tail.totalBytes)})`,
				"---",
				tail.content || "(empty output)",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					truncated: tail.truncated,
					totalLines: tail.totalLines,
					totalBytes: tail.totalBytes,
				},
			};
		}
		case "stop": {
			const shellId = params.shellId;
			if (!shellId) {
				throw new Error(
					"shell_daemon: action=stop requires a `shellId` parameter (see action=ps for live ids)",
				);
			}
			// Serialize with other tool calls; stopShell itself does a
			// read-modify-write on the registry.
			const updated = await withRegistryLock(() => stopShell(shellId, "agent"));
			if (!updated) {
				throw new Error(
					`shell_daemon: unknown shellId "${shellId}" (see action=ps for live ids)`,
				);
			}
			const text = [
				`Stopped shell ${updated.id} (pid ${updated.pid}) — status: ${updated.status}.`,
				`Log preserved at ${updated.logFile}`,
				"Read the tail output with action=logs, then remove the shell with action=close when done.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { id: updated.id, status: updated.status },
			};
		}
		case "close": {
			const shellId = params.shellId;
			if (!shellId) {
				throw new Error(
					"shell_daemon: action=close requires a `shellId` parameter (see action=ps for live ids)",
				);
			}
			// Serialize with other tool calls; closeShell does read-modify-write
			// on the registry (kill + log deletion + record removal).
			const updated = await withRegistryLock(() => closeShell(shellId));
			if (!updated) {
				throw new Error(
					`shell_daemon: unknown shellId "${shellId}" (see action=ps for live ids)`,
				);
			}
			if (updated.status === "running") {
				throw new Error(
					`shell_daemon: could not close shell "${shellId}" — the process is still alive after the termination attempt`,
				);
			}
			const text = [
				`Closed shell ${updated.id} (pid ${updated.pid}) — log deleted, record removed.`,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { id: updated.id, status: updated.status },
			};
		}
		default: {
			// Exhaustive: action is a closed StringEnum union; this guards
			// against future schema drift.
			throw new Error(
				`shell_daemon: unknown action "${String(params.action)}"`,
			);
		}
	}
}

/** Register the shell_daemon tool. Safe to call at extension load: the tool touches session state only at execute time. */
export function registerShellDaemonTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "shell_daemon",
		label: "Shell daemon",
		description:
			"Launch and manage long-running background processes (e.g. `npm run dev`) for the current pi session. Every shell is session-scoped: it dies when the session ends. Output is captured to a log file and readable via action=logs; the ⭕shell TUI monitor shows the running shells. Statuses: running (pid alive) / to close (pid dead). Actions: start (launch), ps (list), status (one shell), logs (tail), stop (terminate the process tree, keep record + log — the shell becomes to close), close (terminate, delete the log, and remove the shell — irreversible).",
		promptSnippet:
			"shell_daemon — launch and manage long-running background processes (npm run dev etc.)",
		promptGuidelines: [
			"Use shell_daemon with action=start to launch long-running background processes (dev servers, watchers, local services) instead of the bash tool; it captures output to a log file and the user can watch the shell in the ⭕shell monitor.",
			"After starting a shell with shell_daemon, check on it with action=ps / status / logs (tail). When the shell's process ends (status to close) or you stop it with action=stop, read the tail output with action=logs first, then remove it with action=close when you're done with it. Every shell_daemon shell dies with the session.",
		],
		parameters: shellDaemonParams,
		execute: executeShellDaemon,
	});
}
