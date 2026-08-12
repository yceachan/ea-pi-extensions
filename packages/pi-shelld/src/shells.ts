import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * pi-shelld shell lifecycle layer (wayfinder ticket T7, ADR-0001).
 *
 * Two-state lifecycle (ADR-0001): every shell is a direct child of the
 * extension, spawned with `detached: true` so it owns its own process
 * group (setsid on Unix) — which makes whole-tree termination a single
 * `kill(-pgid)`. Status is ALWAYS derived from pid liveness at read time:
 * pid alive → `running`; pid dead → `to close`. The `status` field is
 * never persisted.
 *
 * `stop` (kill tree, keep record + log, record `stoppedBy`) and `close`
 * (kill tree + delete log + remove record, irreversible) are separate
 * actions. On transition to to close the extension notifies the agent
 * (via the notifier injected from index.ts) so it can read the tail
 * output before closing; notifications are suppressed for agent-initiated
 * stops (the tool result already said so) and during session sweeps.
 *
 * Session boundary = cleanup: `session_shutdown` and the `session_start`
 * reap sweep everything — nothing survives across sessions, crashes
 * included.
 *
 * State follows the session: the state dir is derived from the session
 * file (absolute path of the current session jsonl), resolved in order:
 * (1) the value injected via {@link setSessionFile} from the extension's
 * `session_start`/`session_shutdown` ctx (the canonical source — pi does
 * NOT expose `PI_SESSION_FILE` to the extension process, only to bash
 * tool executions), (2) the `PI_SESSION_FILE` env var (bash-inherited
 * fallback), (3) `~/.pi/shelld/` as a last resort.
 *
 * Layout: `<dirname>/<session-basename-without-.jsonl>.shelld/` containing
 * `state.json` (atomic tmp+rename writes) and `logs/<shellId>.log`
 * (append-only merged stdout+stderr). The session's extension instance is
 * the only writer; the tool and TUI only read. Because the dir is keyed by
 * session file, a concurrent session's `session_start` reap can never
 * touch this registry (see ADR-0001).
 */

export type ShellStatus = "running" | "to_close";

/** Who initiated an explicit stop — drives the exit notification framing. */
export type StopInitiator = "agent" | "user";

export interface ShellRecord {
	id: string;
	/** Optional agent-given label; the ps list shows the raw command otherwise. */
	name?: string;
	command: string;
	cwd: string;
	pid: number;
	/** Derived from pid liveness at read time — never stored. */
	status: ShellStatus;
	startedAt: number;
	exitedAt?: number;
	/** Set by `stopShell(id, by)`: who stopped the shell, when stopped explicitly. */
	stoppedBy?: StopInitiator;
	logFile: string;
}

export interface SpawnOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	name?: string;
}

export interface SpawnResult {
	id: string;
	pid: number;
	logFile: string;
	startedAt: number;
}

export interface ReapResult {
	/** Records that were stale at reap time (dead or orphaned). */
	reaped: number;
	/** Orphaned live process trees that were killed. */
	killed: number;
	/**
	 * Records still running after the reap. Always 0: the reap sweeps
	 * everything — nothing survives across sessions (ADR-0001).
	 */
	remaining: number;
}

/** Grace window between SIGTERM and SIGKILL for process-tree termination. */
export const DEFAULT_KILL_GRACE_MS = 3000;

let sessionFileOverride: string | undefined;

// ---------------------------------------------------------------------------
// State directory & persistence
// ---------------------------------------------------------------------------

/**
 * The session file backing this registry: injected value wins, then the
 * `PI_SESSION_FILE` env var (present in bash tool executions), else
 * undefined (shared fallback dir). Injected from index.ts session handlers
 * via `ctx.sessionManager.getSessionFile()`.
 */
export function sessionFile(): string | undefined {
	return sessionFileOverride ?? (process.env.PI_SESSION_FILE || undefined);
}

/**
 * Pin the session file (from `ctx.sessionManager.getSessionFile()`); see
 * {@link sessionFile}. Call before any registry access in a session.
 */
export function setSessionFile(file: string | undefined): void {
	sessionFileOverride = file;
}

export function stateDir(): string {
	const sf = sessionFile();
	if (sf) {
		const dir = path.dirname(sf);
		const base = path.basename(sf, ".jsonl");
		return path.join(dir, `${base}.shelld`);
	}
	return path.join(os.homedir(), ".pi", "shelld");
}

function statePath(): string {
	return path.join(stateDir(), "state.json");
}

function logsDir(): string {
	return path.join(stateDir(), "logs");
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: process exists but owned by another user — treat as alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Read the session's shell registry. Status is derived from pid liveness, not trusted from storage. */
export function readState(): ShellRecord[] {
	try {
		const raw = fs.readFileSync(statePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((r) => ({ ...r, status: deriveStatus(r) }));
	} catch {
		return [];
	}
}

/** Atomic write: tmp file in the same directory, then rename. */
export function writeState(shells: ShellRecord[]): void {
	fs.mkdirSync(stateDir(), { recursive: true });
	const tmp = `${statePath()}.tmp-${process.pid}`;
	// `status` is derived at read time, never persisted (ADR-0001).
	const toStore = shells.map(({ status: _status, ...rest }) => rest);
	fs.writeFileSync(tmp, JSON.stringify(toStore, null, 2), "utf8");
	fs.renameSync(tmp, statePath());
}

// ---------------------------------------------------------------------------
// In-process write serialization
// ---------------------------------------------------------------------------

let registryQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize read-modify-write cycles on the registry within this extension
 * instance. pi may batch independent tool calls in parallel; without this,
 * two concurrent `registerShell` calls could both read the empty state and
 * one record would be lost — leaking an untracked process tree. Session
 * handlers (reap/shutdown) use the same lock so shutdown waits for in-flight
 * tool work.
 */
export function withRegistryLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const run = registryQueue.then(fn, fn);
	registryQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** A record is "running" iff its pid is alive; anything else reads as "to close". */
export function deriveStatus(record: ShellRecord): ShellStatus {
	return isPidAlive(record.pid) ? "running" : "to_close";
}

// ---------------------------------------------------------------------------
// Exit notification (ADR-0001)
// ---------------------------------------------------------------------------

/**
 * Per-shell ChildProcess handles, kept only to receive the `exit` event.
 * Handles stay unref'd so they never hold the extension's event loop open;
 * the exit event is the notification trigger ("shell died → tell the agent").
 */
const childHandles = new Map<string, ChildProcess>();

/** True while a session sweep is killing trees — exit notifications are silenced. */
let suppressing = false;

/** Ids whose close is in flight — their exit events must stay silent. */
const closingIds = new Set<string>();

type ExitNotifier = (message: string) => void;
let exitNotifier: ExitNotifier | undefined;

/**
 * Inject the agent-notification sender (wired from index.ts to
 * `pi.sendMessage`); keeps this module free of the ExtensionAPI.
 */
export function setExitNotifier(notifier: ExitNotifier): void {
	exitNotifier = notifier;
}

/** `exit` event handler: decide the notification from the record's stoppedBy. */
function handleShellExit(id: string): void {
	childHandles.delete(id);
	if (suppressing || closingIds.has(id)) return;
	const record = getShell(id);
	// Record gone → closed or swept, nothing to say. Agent-initiated stop →
	// the tool result already told the agent, no notification.
	if (!record || record.stoppedBy === "agent") return;
	const label = record.name ?? record.command;
	const lead =
		record.stoppedBy === "user"
			? `User stopped shell ${label} (pid ${record.pid})`
			: `Shell ${label} (pid ${record.pid}) exited`;
	exitNotifier?.(
		`${lead} — read its tail output with shell_daemon action=logs, then close it with action=close when done.`,
	);
}

// ---------------------------------------------------------------------------
// Registry operations (single writer: the session's extension instance)
// ---------------------------------------------------------------------------

export function registerShell(record: ShellRecord): void {
	const shells = readState();
	const idx = shells.findIndex((s) => s.id === record.id);
	if (idx >= 0) shells[idx] = record;
	else shells.push(record);
	writeState(shells);
}

export function unregisterShell(id: string): ShellRecord | undefined {
	const shells = readState();
	const idx = shells.findIndex((s) => s.id === id);
	if (idx < 0) return undefined;
	const [removed] = shells.splice(idx, 1);
	writeState(shells);
	return removed;
}

/** Read-modify-write one record under the caller's lock. */
function updateShell(
	id: string,
	updater: (record: ShellRecord) => void,
): ShellRecord | undefined {
	const shells = readState();
	const idx = shells.findIndex((s) => s.id === id);
	if (idx < 0) return undefined;
	updater(shells[idx]);
	writeState(shells);
	return shells[idx];
}

export function listShells(): ShellRecord[] {
	return readState();
}

export function getShell(id: string): ShellRecord | undefined {
	return readState().find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a background shell as a direct child of the extension.
 *
 * `detached: true` gives the child its own session + process group (setsid
 * on Unix), so (a) it does not die with us, and (b) the whole tree can be
 * terminated with `kill(-pid)`. stdio is redirected to an append-only log
 * file at spawn time (a detached descendant holding a pipe would keep the
 * parent's wait alive). The child handle is unref'd so it never holds the
 * extension's event loop open; it is kept in {@link childHandles} so the
 * `exit` event can trigger the agent notification.
 *
 * The caller composes the full {@link ShellRecord} (command, cwd, name,
 * status "running") and calls {@link registerShell} immediately.
 */
export function spawnShell(options: SpawnOptions): SpawnResult {
	const { command, cwd, env } = options;
	const id = randomUUID();
	fs.mkdirSync(logsDir(), { recursive: true });
	const logFile = path.join(logsDir(), `${id}.log`);
	const fd = fs.openSync(logFile, "a");
	// `bash -c` (not a login shell): the environment is passed explicitly
	// (process.env already carries the user's PATH, nvm etc.), and a login
	// shell would source ~/.profile and pollute the log with its noise.
	const child = spawn("bash", ["-c", command], {
		cwd,
		env: env ?? process.env,
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true,
	});
	if (!child.pid) {
		fs.closeSync(fd);
		throw new Error(`shell_daemon: failed to spawn command: ${command}`);
	}
	child.unref();
	childHandles.set(id, child);
	child.on("exit", () => handleShellExit(id));
	return { id, pid: child.pid, logFile, startedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/**
 * Terminate a shell's whole process tree: SIGTERM to the process group,
 * grace window, then SIGKILL to the process group. Falls back to killing
 * just the leader pid when the group is gone. Never throws on already-dead
 * processes.
 *
 * @returns true if the pid was still alive after the attempt (kill failed).
 */
export async function killShellTree(
	pid: number,
	graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<boolean> {
	if (!isPidAlive(pid)) return false;

	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	}

	await new Promise((resolve) => setTimeout(resolve, graceMs));

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead — SIGTERM did the job */
		}
	}

	return isPidAlive(pid);
}

/**
 * Stop one shell: tree-kill, keep record + log (the shell becomes
 * to close, `stoppedBy` records who initiated it). The initiator is
 * written BEFORE the kill — the exit event can fire before the kill
 * returns, and the notification framing reads `stoppedBy`.
 *
 * If the kill fails, the shell is still running: `stoppedBy`/`exitedAt`
 * are undone and the record stays `running`.
 */
export async function stopShell(
	id: string,
	by: StopInitiator,
	graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<ShellRecord | undefined> {
	const record = getShell(id);
	if (!record) return undefined;
	updateShell(id, (r) => {
		r.stoppedBy = by;
		r.exitedAt = Date.now();
	});
	const stillAlive = await killShellTree(record.pid, graceMs);
	if (stillAlive) {
		updateShell(id, (r) => {
			delete r.stoppedBy;
			delete r.exitedAt;
		});
	}
	return getShell(id);
}

/**
 * Close one shell (ADR-0001): tree-kill, then delete the log file and
 * remove the record. Irreversible — agent-only, to be called after the
 * agent has read what it needs from the log.
 *
 * If the kill fails (process survived SIGTERM+SIGKILL), the record is kept
 * so the tree stays tracked and the shell reads as `running` again.
 */
export async function closeShell(
	id: string,
	graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<ShellRecord | undefined> {
	const record = getShell(id);
	if (!record) return undefined;
	closingIds.add(id);
	try {
		const stillAlive = await killShellTree(record.pid, graceMs);
		if (stillAlive) return getShell(id);
		try {
			fs.unlinkSync(record.logFile);
		} catch {
			/* log already gone */
		}
		return unregisterShell(id) ?? record;
	} finally {
		closingIds.delete(id);
	}
}

// ---------------------------------------------------------------------------
// Session lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Delete every log file and clear the registry (close-all semantics).
 * Runs under the caller's lock (session handlers wrap it).
 */
function sweepRegistry(): void {
	const shells = readState();
	for (const shell of shells) {
		try {
			fs.unlinkSync(shell.logFile);
		} catch {
			/* log already gone */
		}
	}
	writeState([]);
}

/**
 * `session_shutdown` handler: close every registered shell (idempotent —
 * dead pids are no-ops), then sweep the state. With a session file known
 * the state dir is session-scoped and removed entirely; the fallback dir
 * (`~/.pi/shelld`) is shared across sessions, so only its contents are
 * cleared, never the dir itself.
 */
export async function shutdownShells(
	graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<void> {
	suppressing = true;
	try {
		const shells = readState();
		await Promise.all(shells.map((s) => killShellTree(s.pid, graceMs)));
		sweepRegistry();
		if (sessionFile()) {
			fs.rmSync(stateDir(), { recursive: true, force: true });
		} else {
			fs.rmSync(logsDir(), { recursive: true, force: true });
			try {
				fs.unlinkSync(statePath());
			} catch {
				/* already gone */
			}
		}
	} finally {
		suppressing = false;
	}
}

/**
 * `session_start` handler: sweep stale state left by a previous instance
 * of this session file (ADR-0001: nothing survives across sessions).
 *
 * - Records whose pid is ALIVE are orphans (the previous pi process died
 *   without running `session_shutdown`, e.g. a hard crash) — killed first.
 * - Every stale record is then closed: log deleted, record removed.
 *
 * Runs in parallel over all stale shells, so the SIGTERM grace window is
 * paid once, not per shell.
 */
export async function reapStaleState(
	graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<ReapResult> {
	suppressing = true;
	try {
		const shells = readState();
		const alive = shells.filter((s) => isPidAlive(s.pid));
		await Promise.all(alive.map((s) => killShellTree(s.pid, graceMs)));
		sweepRegistry();
		return {
			reaped: shells.length,
			killed: alive.length,
			remaining: 0,
		};
	} finally {
		suppressing = false;
	}
}
