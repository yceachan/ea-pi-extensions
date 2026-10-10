/**
 * Verb Group planner (pure).
 *
 * Folds maximal runs of strict-neighbor, same Verb Group Kind, settled success|soft
 * Quiet Rows into Verb Groups. Last member is the carrier; earlier members are hidden.
 * Only joinable kinds fold (File, Search, Dir, Other). Command and EditFile stay singletons.
 * Pending rows are always singletons and never join; they do not unpack an already
 * settled same-kind group that ended immediately before them.
 */

import {
	toolParticipatesInQuiet,
	verbGroupJoins,
	verbGroupKind,
	type VerbGroupKind,
} from "./tools-meta.ts";

export type CompactionOutcomeKind = "success" | "soft" | "hard";

export type CompactionRow = {
	toolCallId: string;
	toolName: string;
	/** Quiet built-in that can join groups. */
	quiet: boolean;
	status: "pending" | "settled";
	/** Set when settled (except pure splitters). */
	outcomeKind?: CompactionOutcomeKind;
	chip?: string;
	/** Non-tool transcript boundary (assistant/user prose). */
	splitter?: boolean;
	args?: Record<string, unknown>;
	/** Stored for whole-group Stock expand on the carrier. */
	result?: {
		content: unknown[];
		details?: unknown;
	};
	isError?: boolean;
};

export type CompactionRole = {
	role: "singleton" | "hidden" | "carrier";
	groupId: string;
	carrierId: string;
	memberIds: string[];
};

export type CompactionPlan = Map<string, CompactionRole>;

function rowVerbKind(row: CompactionRow): VerbGroupKind {
	return verbGroupKind(row.toolName);
}

function canJoinGroup(row: CompactionRow): boolean {
	if (row.splitter) return false;
	if (!row.quiet) return false;
	if (row.status !== "settled") return false;
	if (!(row.outcomeKind === "success" || row.outcomeKind === "soft")) return false;
	return verbGroupJoins(rowVerbKind(row));
}

/** Keep full bodies only for rows that may join a Verb Group / need carrier expand. */
export function shouldRetainResult(
	toolName: string,
	outcomeKind: CompactionOutcomeKind | undefined,
): boolean {
	return (
		toolParticipatesInQuiet(toolName) &&
		verbGroupJoins(verbGroupKind(toolName)) &&
		(outcomeKind === "success" || outcomeKind === "soft")
	);
}

/**
 * Plan Verb Group roles for an ordered transcript of tool rows (+ optional splitters).
 * Splitter / non-participating rows still appear as singleton so callers can ignore them.
 *
 * Verb Groups are maximal runs of settled success|soft neighbors sharing a joinable
 * Verb Group Kind. Pending tools never join; a trailing pending same-kind neighbor does
 * not unpack the settled group before it. The group grows only after that tool settles joinably.
 */
export function planCompaction(rows: readonly CompactionRow[]): CompactionPlan {
	const plan: CompactionPlan = new Map();

	const markSingleton = (id: string) => {
		plan.set(id, {
			role: "singleton",
			groupId: id,
			carrierId: id,
			memberIds: [id],
		});
	};

	let i = 0;
	while (i < rows.length) {
		const start = rows[i]!;
		if (!canJoinGroup(start)) {
			markSingleton(start.toolCallId);
			i += 1;
			continue;
		}

		const memberIds = [start.toolCallId];
		const kind = rowVerbKind(start);
		let j = i + 1;
		while (j < rows.length) {
			const next = rows[j]!;
			if (canJoinGroup(next) && rowVerbKind(next) === kind) {
				memberIds.push(next.toolCallId);
				j += 1;
				continue;
			}
			break;
		}

		if (memberIds.length < 2) {
			markSingleton(memberIds[0]!);
			i += 1;
			continue;
		}

		// One shared memberIds array for the whole group (do not mutate after publish).
		const carrierId = memberIds[memberIds.length - 1]!;
		for (let k = 0; k < memberIds.length; k++) {
			const id = memberIds[k]!;
			plan.set(id, {
				role: k === memberIds.length - 1 ? "carrier" : "hidden",
				groupId: carrierId,
				carrierId,
				memberIds,
			});
		}
		i = j;
	}

	return plan;
}

export function roleOf(plan: CompactionPlan, toolCallId: string): CompactionRole {
	const role = plan.get(toolCallId);
	if (role) return role;
	return {
		role: "singleton",
		groupId: toolCallId,
		carrierId: toolCallId,
		memberIds: [toolCallId],
	};
}

function membersChanged(before: CompactionRole, after: CompactionRole): boolean {
	if (before.carrierId !== after.carrierId) return true;
	if (before.memberIds.length !== after.memberIds.length) return true;
	if (before.memberIds === after.memberIds) return false;
	for (let i = 0; i < before.memberIds.length; i++) {
		if (before.memberIds[i] !== after.memberIds[i]) return true;
	}
	return false;
}

/** True when this row's paint surface must refresh after a replan. */
function paintRoleChanged(before: CompactionRole, after: CompactionRole): boolean {
	if (before.role !== after.role) return true;
	// Carriers own the group chrome; membership/carrier identity changes need a repaint.
	if (after.role === "carrier" || before.role === "carrier") {
		return membersChanged(before, after);
	}
	// Hidden staying hidden (or singleton staying singleton) does not need invalidate
	// when only the shared membership list grew.
	return false;
}

/** Mutable index used by the extension runtime. */
export class CompactionIndex {
	private rows: CompactionRow[] = [];
	/** O(1) lookup for non-splitter tool rows. */
	private byId = new Map<string, CompactionRow>();
	private plan: CompactionPlan = new Map();
	private invalidators = new Map<string, () => void>();
	private splitterSeq = 0;

	clear(): void {
		this.rows = [];
		this.byId.clear();
		this.plan = new Map();
		this.invalidators.clear();
		this.splitterSeq = 0;
	}

	getRows(): readonly CompactionRow[] {
		return this.rows;
	}

	getPlan(): CompactionPlan {
		return this.plan;
	}

	role(toolCallId: string): CompactionRole {
		return roleOf(this.plan, toolCallId);
	}

	getRow(toolCallId: string): CompactionRow | undefined {
		return this.byId.get(toolCallId);
	}

	members(carrierId: string): CompactionRow[] {
		const role = this.role(carrierId);
		if (role.role !== "carrier" && role.memberIds.length < 2) {
			const self = this.getRow(carrierId);
			return self ? [self] : [];
		}
		return role.memberIds
			.map((id) => this.getRow(id))
			.filter((r): r is CompactionRow => r !== undefined);
	}

	registerInvalidate(toolCallId: string, invalidate: () => void): void {
		this.invalidators.set(toolCallId, invalidate);
	}

	/** Insert a transcript boundary so later tools are not adjacent to earlier ones. */
	addSplitter(): void {
		this.splitterSeq += 1;
		this.rows.push({
			toolCallId: `split-${this.splitterSeq}`,
			toolName: "",
			quiet: false,
			status: "settled",
			splitter: true,
		});
		this.replan();
	}

	onStart(input: {
		toolCallId: string;
		toolName: string;
		args?: Record<string, unknown>;
	}): void {
		const prev = this.byId.get(input.toolCallId);
		if (prev) {
			// Historical paint / re-render must not unsettle a finished row
			// (that would unpack Compaction Groups rebuilt from session history).
			if (prev.status === "settled") {
				const next: CompactionRow = {
					...prev,
					args: input.args ?? prev.args,
					toolName: input.toolName || prev.toolName,
				};
				this.replaceRow(prev, next);
				return;
			}
			const next: CompactionRow = {
				...prev,
				toolName: input.toolName,
				quiet: toolParticipatesInQuiet(input.toolName),
				status: "pending",
				args: input.args ?? prev.args,
			};
			this.replaceRow(prev, next);
		} else {
			const next: CompactionRow = {
				toolCallId: input.toolCallId,
				toolName: input.toolName,
				quiet: toolParticipatesInQuiet(input.toolName),
				status: "pending",
				args: input.args,
			};
			this.rows.push(next);
			this.byId.set(input.toolCallId, next);
		}
		this.replan();
	}

	onEnd(input: {
		toolCallId: string;
		toolName: string;
		args?: Record<string, unknown>;
		outcomeKind: CompactionOutcomeKind;
		chip?: string;
		result?: CompactionRow["result"];
		isError?: boolean;
	}): void {
		const keepResult = shouldRetainResult(input.toolName, input.outcomeKind);
		const prev = this.byId.get(input.toolCallId);
		const base: CompactionRow = {
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			quiet: toolParticipatesInQuiet(input.toolName),
			status: "settled",
			outcomeKind: input.outcomeKind,
			chip: input.chip,
			args: input.args ?? prev?.args,
			result: keepResult ? input.result : undefined,
			isError: input.isError,
		};
		if (prev) {
			this.replaceRow(prev, base);
		} else {
			this.rows.push(base);
			this.byId.set(input.toolCallId, base);
		}
		this.replan();
	}

	/** Replace index contents (session reload). Does not keep invalidators. */
	rebuild(rows: CompactionRow[]): void {
		this.rows = rows.map((r) => ({ ...r }));
		this.byId.clear();
		for (const row of this.rows) {
			if (!row.splitter) this.byId.set(row.toolCallId, row);
		}
		this.invalidators.clear();
		this.replan(false);
	}

	private replaceRow(prev: CompactionRow, next: CompactionRow): void {
		const idx = this.rows.indexOf(prev);
		if (idx >= 0) {
			this.rows[idx] = next;
		} else {
			this.rows.push(next);
		}
		this.byId.set(next.toolCallId, next);
	}

	private replan(notify = true): void {
		const prev = this.plan;
		this.plan = planCompaction(this.rows);
		if (!notify) return;

		const changed = new Set<string>();
		for (const row of this.rows) {
			if (row.splitter) continue;
			const before = roleOf(prev, row.toolCallId);
			const after = roleOf(this.plan, row.toolCallId);
			if (paintRoleChanged(before, after)) {
				changed.add(row.toolCallId);
			}
		}
		for (const id of changed) {
			this.invalidators.get(id)?.();
		}
	}
}
