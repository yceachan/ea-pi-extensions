import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultAgentDir } from "./protocol.ts";

export interface DoctorFinding {
	kind: "skill" | "script" | "command" | "uv" | "runtime";
	path?: string;
	present: boolean;
	detail: string;
}

export interface DoctorReport {
	packageStateDir: string;
	findings: DoctorFinding[];
	migration: string[];
}

export interface DoctorOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	pathExists?: (path: string) => Promise<boolean>;
	command?: (file: string, args: string[]) => Promise<string>;
	extensionDir?: string;
}

const execFileAsync = promisify(execFile);

/** Inspect legacy browser-harness discovery paths without mutating user files. */
export async function inspectLegacyInstallations(
	options: DoctorOptions = {},
): Promise<DoctorReport> {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const agentDir = defaultAgentDir(env);
	const exists = options.pathExists ?? pathExists;
	const findings: DoctorFinding[] = [];
	const extensionDir =
		options.extensionDir ?? dirname(dirname(fileURLToPath(import.meta.url)));
	const runtimeLock = join(
		extensionDir,
		"runtime",
		"browser-harness",
		"uv.lock",
	);
	findings.push({
		kind: "runtime",
		path: runtimeLock,
		present: await exists(runtimeLock),
		detail: "pinned private runtime lockfile",
	});
	const skillPaths = [
		join(agentDir, "skills", "browser-harness"),
		join(home, ".agents", "skills", "browser-harness"),
	];
	const scriptPaths = [
		...skillPaths.map((path) => join(path, "scripts", "bh-edge")),
		...skillPaths.map((path) => join(path, "scripts", "bh-headless")),
		...skillPaths.map((path) => join(path, "scripts", "bh-edge-close")),
	];
	for (const path of skillPaths) {
		findings.push({
			kind: "skill",
			path,
			present: await exists(path),
			detail: "legacy browser-harness Skill discovery path",
		});
	}
	for (const path of scriptPaths) {
		findings.push({
			kind: "script",
			path,
			present: await exists(path),
			detail: "legacy browser-harness launcher path",
		});
	}

	const commandPath = await findCommand("browser-harness", options);
	findings.push({
		kind: "command",
		path: commandPath,
		present: Boolean(commandPath),
		detail: "legacy browser-harness executable on PATH",
	});
	const uvVersion = await runCommand("uv", ["--version"], options);
	findings.push({
		kind: "uv",
		present: Boolean(uvVersion.trim()),
		detail: "uv is required to create the pinned runtime environment",
	});
	const uvOutput = await runCommand("uv", ["tool", "list"], options);
	findings.push({
		kind: "uv",
		present: /(^|\s)browser-harness(\s|$)/m.test(uvOutput),
		detail: "legacy browser-harness uv tool installation",
	});

	return {
		packageStateDir: join(agentDir, "pi-wsl-browser"),
		findings,
		migration: [
			"Review and remove legacy Skill, launcher, or uv entries manually after checking the findings.",
			"Keep the package-provided browser-harness Skill and invoke pi-wsl-browser run only after acquiring a lease.",
			"This doctor does not delete user files, browser profiles, processes, or credentials.",
		],
	};
}

export function formatDoctorReport(report: DoctorReport): string {
	const lines = [
		"pi-wsl-browser doctor",
		`package state: ${report.packageStateDir}`,
		"",
		"Legacy discovery paths:",
		...report.findings.map(
			(finding) =>
				`  ${finding.present ? "FOUND" : "absent"} ${finding.kind}${finding.path ? `: ${finding.path}` : ""} — ${finding.detail}`,
		),
		"",
		"Migration:",
		...report.migration.map((line) => `  ${line}`),
	];
	return `${lines.join("\n")}\n`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function findCommand(
	name: string,
	options: DoctorOptions,
): Promise<string | undefined> {
	const output = await runCommand("which", [name], options);
	return output.trim().split(/\r?\n/)[0] || undefined;
}

async function runCommand(
	file: string,
	args: string[],
	options: DoctorOptions,
): Promise<string> {
	if (options.command) return options.command(file, args);
	try {
		const result = await execFileAsync(file, args, {
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		});
		return String(result.stdout ?? "");
	} catch {
		return "";
	}
}

if (import.meta.main) {
	const report = await inspectLegacyInstallations();
	process.stdout.write(formatDoctorReport(report));
}
