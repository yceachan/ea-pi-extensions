import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, setGadgetStatus, setProjectStatus } from "../config.ts";
import { completeArguments } from "../pi-gadgets.ts";

function makeTree() {
	const root = mkdtempSync(join(tmpdir(), "pi-gadget-config-"));
	const bundleDir = join(root, "bundle");
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(bundleDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi", "pi-gadget"), { recursive: true });

	const write = (path: string, value: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	};
	const load = () => loadConfig({ extensionDir: bundleDir, agentDir, cwd });
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	return { bundleDir, agentDir, cwd, write, load, cleanup };
}

describe("pi-gadget config", () => {
	test("defaults every gadget to enabled", () => {
		const tree = makeTree();
		try {
			expect(tree.load()).toEqual({
				"pi-clear": "enabled",
				"pi-exit": "enabled",
				"pi-cite-wslpath": "enabled",
			});
		} finally {
			tree.cleanup();
		}
	});

	test("layers bundle, user, and project with project taking precedence", () => {
		const tree = makeTree();
		try {
			tree.write(join(tree.bundleDir, "config.json"), {
				"pi-clear": { status: "disabled" },
				"pi-exit": { status: "disabled" },
			});
			tree.write(join(tree.agentDir, "pi-gadget", "config.json"), {
				"pi-clear": { status: "enabled" },
				"pi-cite-wslpath": { status: "disabled" },
			});
			tree.write(join(tree.cwd, ".pi", "pi-gadget", "config.json"), {
				"pi-clear": { status: "disabled" },
			});

			expect(tree.load()).toEqual({
				"pi-clear": "disabled",
				"pi-exit": "disabled",
				"pi-cite-wslpath": "disabled",
			});
		} finally {
			tree.cleanup();
		}
	});

	test("writes a project override without dropping existing entries", () => {
		const tree = makeTree();
		try {
			const path = join(tree.cwd, ".pi", "pi-gadget", "config.json");
			tree.write(path, { "pi-exit": { status: "disabled" } });
			setProjectStatus("pi-clear", "disabled", tree.cwd);

			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				"pi-exit": { status: "disabled" },
				"pi-clear": { status: "disabled" },
			});
			expect(tree.load()["pi-clear"]).toBe("disabled");
		} finally {
			tree.cleanup();
		}
	});

	test("global status only creates the global file when project config is missing", () => {
		const tree = makeTree();
		try {
			setGadgetStatus("pi-clear", "disabled", {
				global: true,
				agentDir: tree.agentDir,
				cwd: tree.cwd,
			});

			expect(existsSync(join(tree.agentDir, "pi-gadget", "config.json"))).toBe(
				true,
			);
			expect(existsSync(join(tree.cwd, ".pi", "pi-gadget", "config.json"))).toBe(
				false,
			);
			expect(tree.load()["pi-clear"]).toBe("disabled");
		} finally {
			tree.cleanup();
		}
	});

	test("global status also updates an existing project config", () => {
		const tree = makeTree();
		try {
			const projectPath = join(tree.cwd, ".pi", "pi-gadget", "config.json");
			tree.write(projectPath, { "pi-exit": { status: "disabled" } });
			setGadgetStatus("pi-clear", "disabled", {
				global: true,
				agentDir: tree.agentDir,
				cwd: tree.cwd,
			});

			expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({
				"pi-exit": { status: "disabled" },
				"pi-clear": { status: "disabled" },
			});
			expect(
				JSON.parse(
					readFileSync(join(tree.agentDir, "pi-gadget", "config.json"), "utf8"),
				),
			).toEqual({ "pi-clear": { status: "disabled" } });
		} finally {
			tree.cleanup();
		}
	});

	test("completes actions, the global flag, and gadget ids", () => {
		expect(completeArguments("di")).toEqual([
			{ value: "disable", label: "disable" },
		]);
		expect(completeArguments("enable --g")).toEqual([
			{ value: "enable --global", label: "--global" },
		]);
		expect(completeArguments("disable --global pi-")).toEqual([
			{ value: "disable --global pi-clear", label: "pi-clear" },
			{ value: "disable --global pi-exit", label: "pi-exit" },
			{ value: "disable --global pi-cite-wslpath", label: "pi-cite-wslpath" },
		]);
	});
});
