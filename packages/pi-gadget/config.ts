import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GADGET_IDS = ["pi-clear", "pi-exit", "pi-cite-wslpath"] as const;

export type GadgetId = (typeof GADGET_IDS)[number];
export type GadgetStatus = "enabled" | "disabled";
export type GadgetConfig = Record<GadgetId, GadgetStatus>;

export interface LoadConfigOptions {
	extensionDir?: string;
	agentDir?: string;
	cwd?: string;
}

export interface SetGadgetStatusOptions {
	cwd?: string;
	agentDir?: string;
	global?: boolean;
}

type ConfigLayer = Partial<Record<GadgetId, { status?: GadgetStatus }>>;

const bundleDir = dirname(fileURLToPath(import.meta.url));

function defaultAgentDir(): string {
	return (
		process.env.PI_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent")
	);
}

function readLayer(path: string): ConfigLayer {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ConfigLayer;
	} catch {
		return {};
	}
}

export function loadConfig(options: LoadConfigOptions = {}): GadgetConfig {
	const config = {} as GadgetConfig;
	for (const id of GADGET_IDS) config[id] = "enabled";

	const extensionDir = options.extensionDir ?? bundleDir;
	const agentDir = options.agentDir ?? defaultAgentDir();
	const cwd = options.cwd ?? process.cwd();
	const paths = [
		join(extensionDir, "config.json"),
		join(agentDir, "pi-gadget", "config.json"),
		join(cwd, ".pi", "pi-gadget", "config.json"),
	];

	for (const path of paths) {
		const layer = readLayer(path);
		for (const id of GADGET_IDS) {
			const status = layer[id]?.status;
			if (status === "enabled" || status === "disabled") {
				config[id] = status;
			}
		}
	}

	return config;
}

export function isGadgetEnabled(id: GadgetId): boolean {
	return loadConfig()[id] === "enabled";
}

export function globalConfigPath(agentDir = defaultAgentDir()): string {
	return join(agentDir, "pi-gadget", "config.json");
}

export function projectConfigPath(cwd = process.cwd()): string {
	return join(cwd, ".pi", "pi-gadget", "config.json");
}

function setStatusAtPath(
	path: string,
	id: GadgetId,
	status: GadgetStatus,
): void {
	let layer: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			layer = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			throw new Error(`Invalid pi-gadget config: ${path}`);
		}
	}
	layer[id] = { ...(layer[id] as Record<string, unknown> | undefined), status };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(layer, null, 2)}\n`);
}

export function setProjectStatus(
	id: GadgetId,
	status: GadgetStatus,
	cwd = process.cwd(),
): void {
	setStatusAtPath(projectConfigPath(cwd), id, status);
}

export function setGlobalStatus(
	id: GadgetId,
	status: GadgetStatus,
	agentDir = defaultAgentDir(),
): void {
	setStatusAtPath(globalConfigPath(agentDir), id, status);
}

export function setGadgetStatus(
	id: GadgetId,
	status: GadgetStatus,
	options: SetGadgetStatusOptions = {},
): void {
	const cwd = options.cwd ?? process.cwd();
	if (!options.global) {
		setProjectStatus(id, status, cwd);
		return;
	}
	setGlobalStatus(id, status, options.agentDir);
	if (existsSync(projectConfigPath(cwd))) {
		setProjectStatus(id, status, cwd);
	}
}
