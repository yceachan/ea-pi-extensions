import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeProcessEnv,
	setSessionFile,
	stateDir,
	writeState,
	type ShellRecord,
} from "../src/shells.ts";

describe("pi-shelld service environment overlays", () => {
	test("inherits, overrides, adds, and deletes environment keys", () => {
		const inheritedKey = "PI_SHELLD_TEST_INHERITED";
		const overrideKey = "PI_SHELLD_TEST_OVERRIDE";
		const deleteKey = "PI_SHELLD_TEST_DELETE";
		const addedKey = "PI_SHELLD_TEST_ADDED";
		const previous = new Map(
			[inheritedKey, overrideKey, deleteKey, addedKey].map((key) => [
				key,
				process.env[key],
			]),
		);

		process.env[inheritedKey] = "parent";
		process.env[overrideKey] = "parent";
		process.env[deleteKey] = "secret";
		delete process.env[addedKey];
		try {
			const merged = mergeProcessEnv({
				[overrideKey]: "child",
				[deleteKey]: undefined,
				[addedKey]: "new",
			});

			expect(merged[inheritedKey]).toBe("parent");
			expect(merged[overrideKey]).toBe("child");
			expect(merged[deleteKey]).toBeUndefined();
			expect(merged[addedKey]).toBe("new");
			expect(process.env[deleteKey]).toBe("secret");
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("persisted shell records contain no environment overlay", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-shelld-state-"));
		setSessionFile(join(root, "session.jsonl"));
		const record: ShellRecord = {
			id: "shell-1",
			command: "sleep 1",
			cwd: root,
			pid: 1,
			status: "running",
			startedAt: 1,
			logFile: join(root, "shell.log"),
		};

		try {
			writeState([record]);
			const stored = JSON.parse(
				readFileSync(join(stateDir(), "state.json"), "utf8"),
			) as Array<Record<string, unknown>>;
			expect(stored).toHaveLength(1);
			expect(stored[0]).not.toHaveProperty("env");
			expect(stored[0]).not.toHaveProperty("status");
		} finally {
			setSessionFile(undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
