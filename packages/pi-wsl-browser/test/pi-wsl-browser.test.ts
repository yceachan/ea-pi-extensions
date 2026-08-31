import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DEFAULT_AUTHORIZATION_TIMEOUT_MS, loadConfig } from "../src/config.ts";
import {
	WindowsBrowserDiscovery,
	type BrowserInstallation,
} from "../src/discovery.ts";
import {
	BrowserController,
	buildDaemonCommand,
	buildDaemonEnvironment,
	type ControlClientLike,
} from "../controller/controller.ts";
import {
	BrowserLifecycle,
	type LifecycleController,
} from "../src/lifecycle.ts";
import { inspectLegacyInstallations } from "../src/doctor.ts";
import { createWslBrowserToolRuntime } from "../src/tool.ts";
import {
	encodeControlRequest,
	parseControlResponse,
	resolveSessionIdentity,
	descriptorPath,
	type BrowserMode,
	type ControlResponse,
	type LeaseStatus,
	type ShelldExit,
	type ShelldServiceV1,
	WslBrowserError,
} from "../src/protocol.ts";
import {
	createBrowserLaunchManager,
	launchBrowser,
	type BrowserHandle,
	type BrowserLaunchManager,
} from "../controller/windows-browser.ts";

function makeConfig(
	agentDir: string,
	overrides: Partial<ReturnType<typeof loadConfig>> = {},
) {
	return {
		browser: "auto" as const,
		startupTimeoutMs: 1_000,
		authorizationTimeoutMs: DEFAULT_AUTHORIZATION_TIMEOUT_MS,
		pollIntervalMs: 1,
		controlTimeoutMs: 20,
		runtime: {
			python: "python3",
			root: join(agentDir, "runtime", "src"),
			project: join(agentDir, "runtime"),
		},
		agentDir,
		...overrides,
	};
}

function makeInstallation(
	kind: "edge" | "chrome" = "edge",
): BrowserInstallation {
	return {
		kind,
		executable: `/fake/${kind}.exe`,
		userDataDir: "/fake/User Data",
		temporaryProfileRoot: "/mnt/c/Users/test/AppData/Local/Temp/pi-wsl-browser",
		profileDirectory: "Profile 2",
		profileSource: "last_used",
		environmentPresent: true,
	};
}

function makeBrowser(mode: BrowserMode): BrowserHandle {
	return {
		kind: "edge",
		mode,
		executable: "/fake/msedge.exe",
		profileDirectory: "Profile 2",
		userDataDir: "/fake/User Data",
		profilePath: `/tmp/fake-${mode}`,
		marker: "pi-wsl-browser-session-marker",
		temporary: mode !== "main-profile",
		pid: 1234,
		cdp: {
			port: 41_234,
			webSocketPath: "/devtools/browser/fake",
			webSocketUrl: "ws://127.0.0.1:41234/devtools/browser/fake",
			httpUrl: "http://127.0.0.1:41234",
		},
		cdpEnvName: mode === "main-profile" ? "BU_CDP_WS" : "BU_CDP_URL",
		cdpEnvValue:
			mode === "main-profile"
				? "ws://127.0.0.1:41234/devtools/browser/fake"
				: "http://127.0.0.1:41234",
	};
}

class FakeShelldService implements ShelldServiceV1 {
	readonly starts: Array<{
		command: string;
		cwd: string;
		name?: string;
		env?: NodeJS.ProcessEnv;
	}> = [];
	readonly closeCalls: string[] = [];
	private resolveExit!: (exit: ShelldExit) => void;
	private exitPromise: Promise<ShelldExit>;

	constructor(private readonly logFile: string) {
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
	}

	async start(options: {
		command: string;
		cwd: string;
		name?: string;
		env?: NodeJS.ProcessEnv;
	}) {
		this.starts.push(options);
		return {
			shellId: `fake-shell-${this.starts.length}`,
			logFile: this.logFile,
			startedAt: Date.now(),
			settled: this.exitPromise,
		};
	}

	async close(shellId: string): Promise<void> {
		this.closeCalls.push(shellId);
	}

	settle(exit: ShelldExit): void {
		this.resolveExit(exit);
	}
}

class FakeControlClient implements ControlClientLike {
	readonly requests: Array<{
		action: string;
		mode?: BrowserMode;
		profile?: string;
		marker?: string;
	}> = [];
	private nextLease = 0;

	async request<T = Record<string, unknown>>(fields: {
		action: "health" | "acquire-root" | "release-root" | "status" | "shutdown";
		mode?: BrowserMode;
		profile?: string;
		marker?: string;
	}): Promise<ControlResponse<T>> {
		this.requests.push(fields);
		switch (fields.action) {
			case "health":
				return { ok: true, data: { ready: true } as T };
			case "acquire-root":
				this.nextLease += 1;
				return {
					ok: true,
					data: {
						leaseId: `lease-${this.nextLease}`,
						rootTargetId: "root-1",
						ownedTargetIds: ["root-1"],
						mode: fields.mode,
					} as T,
				};
			case "status":
				return { ok: true, data: { daemon: "running" } as T };
			default:
				return { ok: true, data: {} as T };
		}
	}
}

function makeController(
	root: string,
	client: ControlClientLike,
	service: FakeShelldService,
) {
	const browserManager: BrowserLaunchManager = {
		async launch({ mode }) {
			return makeBrowser(mode);
		},
		async close() {},
	};
	return new BrowserController({
		session: resolveSessionIdentity({ sessionFile: join(root, "session.jsonl") }),
		config: makeConfig(root),
		service,
		discovery: { discover: async () => makeInstallation() },
		browser: browserManager,
		controlClientFactory: () => client,
		socketPath: join(root, "managed.sock"),
	});
}

describe("protocol and configuration", () => {
	test("round-trips the shared JSON golden envelope", () => {
		const fixtureDir = join(
			dirname(fileURLToPath(import.meta.url)),
			"fixtures",
			"protocol",
		);
		const request = JSON.parse(
			readFileSync(join(fixtureDir, "acquire-root.request.json"), "utf8"),
		);
		expect(encodeControlRequest(request)).toBe(`${JSON.stringify(request)}\n`);
		const success = JSON.parse(
			readFileSync(join(fixtureDir, "acquire-root.success.json"), "utf8"),
		);
		expect(parseControlResponse(success)).toEqual(success);
		const failure = JSON.parse(
			readFileSync(join(fixtureDir, "control.failure.json"), "utf8"),
		);
		expect(parseControlResponse(failure)).toEqual(failure);
	});

	test("session identity and daemon launch keep secrets out of command text", () => {
		const identity = resolveSessionIdentity({
			sessionFile: "/tmp/pi/session.jsonl",
		});
		expect(identity.sessionKey).toMatch(/^[0-9a-f]{32}$/);
		expect(descriptorPath(identity.sessionKey, "/tmp/pi-agent")).toContain(
			`${identity.sessionKey}.json`,
		);
		const command = buildDaemonCommand({
			python: "python3",
			runtimeProjectRoot: "/package/runtime",
		});
		expect(command).toBe("'python3' -m browser_harness.daemon");
		expect(command).not.toContain("secret-token");
		expect(command).not.toContain("127.0.0.1");
		const environment = buildDaemonEnvironment({
			runtimeRoot: "/package/runtime/src",
			runtimeDir: "/agent/session/runtime",
			tmpDir: "/agent/session/tmp",
			socketPath: "/tmp/managed.sock",
			controlToken: "secret-token",
			cdpEnvName: "BU_CDP_URL",
			cdpEnvValue: "http://127.0.0.1:43123",
		});
		expect(environment.BH_MANAGED_CONTROL_TOKEN).toBe("secret-token");
		expect(environment.BH_RUNTIME_DIR).toBe("/agent/session/runtime");
		expect(environment.BH_TMP_DIR).toBe("/agent/session/tmp");
		expect(environment.BU_CDP_URL).toBe("http://127.0.0.1:43123");
		expect(environment.BU_CDP_WS).toBeUndefined();
		const uvCommand = buildDaemonCommand({
			python: "uv",
			runtimeProjectRoot: "/package/runtime",
		});
		expect(uvCommand).toBe(
			"uv run --project '/package/runtime' --frozen python -m browser_harness.daemon",
		);
		expect(uvCommand).not.toContain("BH_MANAGED");
		expect(uvCommand).not.toContain("BU_CDP");
	});

	test("runtime config fields cannot replace the bundled uv project", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-runtime-config-"));
		const bundle = join(root, "bundle.json");
		const user = join(root, "user.json");
		writeFileSync(
			bundle,
			JSON.stringify({
				runtime: {
					python: "/tmp/attacker-python",
					root: "/tmp/attacker-root",
					project: "/tmp/attacker-project",
				},
			}),
		);
		writeFileSync(
			user,
			JSON.stringify({
				runtime: {
					python: "/tmp/user-python",
					root: "/tmp/user-root",
					project: "/tmp/user-project",
				},
				python: "/tmp/flat-python",
				runtimeRoot: "/tmp/flat-root",
			}),
		);
		try {
			const config = loadConfig({
				extensionDir: root,
				bundleConfigPath: bundle,
				userConfigPath: user,
			});
			expect(config.runtime.python).toBe("uv");
			expect(config.runtime.root).toBe(
				join(root, "runtime", "browser-harness", "src"),
			);
			expect(config.runtime.project).toBe(
				join(root, "runtime", "browser-harness"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("user config overrides bundle config without requiring a config file", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-config-"));
		const bundle = join(root, "bundle.json");
		const user = join(root, "user.json");
		writeFileSync(
			bundle,
			JSON.stringify({ browser: "auto", profileDirectory: "Default" }),
		);
		writeFileSync(
			user,
			JSON.stringify({ browser: "chrome", profileDirectory: "Profile 3" }),
		);
		try {
			const config = loadConfig({
				bundleConfigPath: bundle,
				userConfigPath: user,
			});
			expect(config.browser).toBe("chrome");
			expect(config.profileDirectory).toBe("Profile 3");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("doctor", () => {
	test("reports legacy paths and missing uv without changing files", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-doctor-"));
		const legacySkill = join(root, "skills", "browser-harness");
		try {
			const report = await inspectLegacyInstallations({
				env: { PI_CODING_AGENT_DIR: root },
				home: root,
				pathExists: async (path) => path === legacySkill,
				command: async (file, args) => {
					if (file === "which" && args[0] === "browser-harness")
						return "/tmp/browser-harness";
					if (file === "uv" && args[0] === "--version") return "";
					return "";
				},
				extensionDir: root,
			});
			expect(
				report.findings.some(
					(finding) => finding.kind === "command" && finding.present,
				),
			).toBe(true);
			expect(
				report.findings.some(
					(finding) => finding.kind === "uv" && !finding.present,
				),
			).toBe(true);
			expect(
				report.findings.some(
					(finding) => finding.kind === "skill" && finding.present,
				),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("managed wrapper", () => {
	test("derives the current descriptor with a relative agent dir and invokes bundled uv", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-wrapper-"));
		const sessionFile = join(root, "session.jsonl");
		const agentDir = join(root, "agent");
		const capture = join(root, "runtime-env.txt");
		const identity = resolveSessionIdentity({ sessionFile });
		const descriptorFile = descriptorPath(identity.sessionKey, agentDir);
		const stateRoot = join(dirname(descriptorFile), identity.sessionKey);
		const runtimeDir = join(stateRoot, "runtime");
		const tmpDir = join(stateRoot, "tmp");
		const fakeBin = join(root, "fake-bin");
		const fakeUv = join(fakeBin, "uv");
		const fakePython = join(root, "fake-python");
		mkdirSync(dirname(descriptorFile), { recursive: true });
		mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
		mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			descriptorFile,
			JSON.stringify({
				version: 1,
				sessionId: sessionFile,
				sessionKey: identity.sessionKey,
				sessionFile,
				socketPath: join(stateRoot, "session.sock"),
				runtimeDir,
				tmpDir,
				daemon: { status: "running" },
				lease: {
					leaseId: "lease",
					rootTargetId: "root",
					ownedTargetIds: ["root"],
					mode: "headless",
					retained: false,
				},
				updatedAt: Date.now(),
			}),
		);
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(
			fakePython,
			String.raw`#!/usr/bin/env bash
{ printf 'args=%s\\n' "$*"; env | grep -E '^(BH_MANAGED_SOCKET|BH_RUNTIME_DIR|BH_TMP_DIR|PYTHONPATH|BU_CDP_URL|BU_CDP_WS|BU_NAME)=' || true; } > "$FAKE_CAPTURE"
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			fakeUv,
			String.raw`#!/usr/bin/env bash
exec "$FAKE_PYTHON" "$@"
`,
			{ mode: 0o755 },
		);
		const wrapper = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"bin",
			"pi-wsl-browser",
		);
		try {
			const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
			const env = {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
				PI_CODING_AGENT_DIR: "agent",
				PI_SESSION_FILE: sessionFile,
				PI_WSL_BROWSER_PYTHON: "/agent-must-not-choose",
				PI_WSL_BROWSER_RUNTIME_ROOT: "/agent-must-not-choose",
				PI_WSL_BROWSER_RUNTIME_PROJECT: "/agent-must-not-choose",
				PYTHONPATH: "agent-must-not-choose",
				FAKE_CAPTURE: capture,
				FAKE_PYTHON: fakePython,
				BU_CDP_URL: "http://agent-must-not-choose",
				BU_CDP_WS: "ws://agent-must-not-choose",
				BU_NAME: "arbitrary-daemon",
			};
			const result = spawnSync(wrapper, ["run"], {
				cwd: root,
				env,
				input: "print('ok')\\n",
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
			const output = readFileSync(capture, "utf8");
			expect(output).toContain(
				`BH_MANAGED_SOCKET=${join(stateRoot, "session.sock")}`,
			);
			expect(output).toContain(`BH_RUNTIME_DIR=${runtimeDir}`);
			expect(output).toContain(`BH_TMP_DIR=${tmpDir}`);
			expect(output).toContain(
				`PYTHONPATH=${join(packageRoot, "runtime", "browser-harness", "src")}`,
			);
			expect(output).toContain("args=run --project");
			expect(output).toContain("--frozen python -m browser_harness.run");
			expect(output).not.toContain("BU_CDP_URL=");
			expect(output).not.toContain("BU_CDP_WS=");
			expect(output).not.toContain("BU_NAME=");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses lexical paths for symlinked session files and agent directories", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-wrapper-symlink-"));
		const realSessionFile = join(root, "real-session.jsonl");
		const sessionFile = join(root, "session.jsonl");
		const realAgentDir = join(root, "real-agent");
		const agentDir = join(root, "agent");
		const fakeBin = join(root, "fake-bin");
		const fakeUv = join(fakeBin, "uv");
		writeFileSync(realSessionFile, "");
		mkdirSync(realAgentDir, { recursive: true });
		symlinkSync(realSessionFile, sessionFile);
		symlinkSync(realAgentDir, agentDir, "dir");
		const identity = resolveSessionIdentity({ sessionFile });
		const descriptorFile = descriptorPath(identity.sessionKey, agentDir);
		const stateRoot = join(dirname(descriptorFile), identity.sessionKey);
		const runtimeDir = join(stateRoot, "runtime");
		const tmpDir = join(stateRoot, "tmp");
		mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
		mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
		writeFileSync(
			descriptorFile,
			JSON.stringify({
				version: 1,
				sessionId: sessionFile,
				sessionKey: identity.sessionKey,
				sessionFile,
				socketPath: join(stateRoot, "session.sock"),
				runtimeDir,
				tmpDir,
				daemon: { status: "running" },
				lease: {
					leaseId: "lease",
					rootTargetId: "root",
					ownedTargetIds: ["root"],
					mode: "headless",
					retained: false,
				},
				updatedAt: Date.now(),
			}),
		);
		mkdirSync(fakeBin, { recursive: true });
		writeFileSync(fakeUv, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
		const wrapper = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"bin",
			"pi-wsl-browser",
		);
		try {
			const result = spawnSync(wrapper, ["run"], {
				env: {
					...process.env,
					PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
					PI_CODING_AGENT_DIR: agentDir,
					PI_SESSION_FILE: sessionFile,
				},
				input: "print('ok')\\n",
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses to run without an active lease descriptor", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-wrapper-missing-"));
		const wrapper = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"bin",
			"pi-wsl-browser",
		);
		try {
			const result = spawnSync(wrapper, ["run"], {
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: join(root, "agent"),
					PI_SESSION_FILE: join(root, "session.jsonl"),
				},
				input: "print('should not run')\\n",
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("managed_descriptor_missing");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a descriptor whose control socket leaves session state", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-wrapper-socket-"));
		const sessionFile = join(root, "session.jsonl");
		const agentDir = join(root, "agent");
		const identity = resolveSessionIdentity({ sessionFile });
		const descriptorFile = descriptorPath(identity.sessionKey, agentDir);
		const stateRoot = join(dirname(descriptorFile), identity.sessionKey);
		const wrapper = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"bin",
			"pi-wsl-browser",
		);
		mkdirSync(stateRoot, { recursive: true });
		mkdirSync(join(stateRoot, "runtime"), { recursive: true });
		mkdirSync(join(stateRoot, "tmp"), { recursive: true });
		writeFileSync(
			descriptorFile,
			JSON.stringify({
				version: 1,
				sessionId: sessionFile,
				sessionKey: identity.sessionKey,
				sessionFile,
				socketPath: join(root, "outside.sock"),
				runtimeDir: join(stateRoot, "runtime"),
				tmpDir: join(stateRoot, "tmp"),
				daemon: { status: "running" },
				lease: { leaseId: "lease" },
				updatedAt: Date.now(),
			}),
		);
		try {
			const result = spawnSync(wrapper, ["run"], {
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_SESSION_FILE: sessionFile,
				},
				input: "print('should not run')\\n",
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain(
				"socketPath must stay inside the current session state",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("package surface", () => {
	test("packs production runtime assets without vendored test or config files", () => {
		const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
		const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: packageRoot,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const manifest = JSON.parse(result.stdout) as Array<{
			files?: Array<{ path: string; mode: number }>;
		}>;
		const files = new Map(
			(manifest[0]?.files ?? []).map((file) => [file.path, file]),
		);
		for (const required of [
			"runtime/browser-harness/src/browser_harness/daemon.py",
			"runtime/browser-harness/src/browser_harness/SKILL.md",
			"runtime/browser-harness/src/browser_harness/video-template.html",
			"runtime/browser-harness/pyproject.toml",
			"runtime/browser-harness/README.md",
			"runtime/browser-harness/uv.lock",
			"runtime/browser-harness/LICENSE",
			"runtime/browser-harness/UPSTREAM_BASELINE.json",
		]) {
			expect(files.has(required)).toBe(true);
		}
		expect(
			[...files.keys()].some((file) =>
				file.startsWith("runtime/browser-harness/tests/"),
			),
		).toBe(false);
		for (const excluded of [
			"runtime/browser-harness/.pi-lens.json",
			"runtime/browser-harness/pyrightconfig.json",
			"runtime/browser-harness/.gitignore",
			"runtime/browser-harness/browser-harness",
		]) {
			expect(files.has(excluded)).toBe(false);
		}
		for (const executable of [
			"bin/pi-wsl-browser",
			"bin/pi-wsl-browser-doctor",
		]) {
			expect((files.get(executable)?.mode ?? 0) & 0o111).not.toBe(0);
		}
	});
});

describe("Windows browser discovery", () => {
	test("uses Edge when its environment exists and infers Local State last_used", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-discovery-"));
		const data = join(root, "Microsoft", "Edge", "User Data");
		const executable = join(root, "msedge.exe");
		mkdirSync(data, { recursive: true });
		writeFileSync(
			join(data, "Local State"),
			JSON.stringify({ profile: { last_used: "Profile 7" } }),
		);
		writeFileSync(executable, "fake");
		try {
			const discovery = new WindowsBrowserDiscovery({
				localAppData: root,
				pathExists: async (path) => path === executable || path === data,
				run: async () => ({ stdout: "", stderr: "", code: 1 }),
			});
			const config = makeConfig(root);
			// The known executable path is not under this fixture, so configure it
			// explicitly while keeping the user-data path discovered.
			const installation = await discovery.discover(
				{ ...config, executable, browser: "edge" },
				"main-profile",
			);
			expect(installation.kind).toBe("edge");
			expect(installation.profileDirectory).toBe("Profile 7");
			expect(installation.userDataDir).toBe(data);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to Chrome only when Edge is absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-chrome-"));
		const chrome = join(root, "chrome.exe");
		writeFileSync(chrome, "fake");
		try {
			const discovery = new WindowsBrowserDiscovery({
				localAppData: join(root, "no-edge-data"),
				windowsTempPath: "/mnt/c/Users/test/AppData/Local/Temp",
				pathExists: async (path) => path === chrome,
				run: async (file) =>
					file === "which" && false
						? { stdout: chrome, stderr: "", code: 0 }
						: { stdout: "", stderr: "", code: 1 },
			});
			const installation = await discovery.discover(
				{ ...makeConfig(root), executable: chrome, browser: "auto" },
				"headless",
			);
			expect(installation.kind).toBe("chrome");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ignores leftover Edge user data when selecting the Chrome fallback", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-edge-leftover-"));
		const edgeData = join(root, "Microsoft", "Edge", "User Data");
		const chrome = join(root, "Google", "Chrome", "Application", "chrome.exe");
		mkdirSync(edgeData, { recursive: true });
		mkdirSync(dirname(chrome), { recursive: true });
		writeFileSync(chrome, "fake");
		try {
			const discovery = new WindowsBrowserDiscovery({
				localAppData: root,
				windowsTempPath: "/mnt/c/Users/test/AppData/Local/Temp",
				pathExists: async (path) => path === edgeData || path === chrome,
				run: async () => ({ stdout: "", stderr: "", code: 1 }),
			});
			const installation = await discovery.discover(makeConfig(root), "headless");
			expect(installation.kind).toBe("chrome");
			expect(installation.executable).toBe(chrome);
			expect(installation.temporaryProfileRoot).toBe(
				"/mnt/c/Users/test/AppData/Local/Temp",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("discovers a Windows temp path and rejects WSL-only overrides", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-temp-discovery-"));
		const executable = join(root, "msedge.exe");
		writeFileSync(executable, "fake");
		try {
			const discovery = new WindowsBrowserDiscovery({
				localAppData: root,
				pathExists: async (path) => path === executable,
				run: async (file, args) => {
					if (
						file === "powershell.exe" &&
						args.at(-1) === "[IO.Path]::GetTempPath()"
					) {
						return {
							stdout: "C:\\Users\\test\\AppData\\Local\\Temp\n",
							stderr: "",
							code: 0,
						};
					}
					if (file === "wslpath") {
						return {
							stdout: "/mnt/c/Users/test/AppData/Local/Temp\n",
							stderr: "",
							code: 0,
						};
					}
					return { stdout: "", stderr: "", code: 1 };
				},
			});
			const installation = await discovery.discover(
				{ ...makeConfig(root), executable, browser: "edge" },
				"headless",
			);
			expect(installation.temporaryProfileRoot).toBe(
				"/mnt/c/Users/test/AppData/Local/Temp",
			);

			let failure: unknown;
			try {
				await discovery.discover(
					{
						...makeConfig(root),
						executable,
						browser: "edge",
						tempProfileRoot: "/tmp",
					},
					"headless",
				);
			} catch (error) {
				failure = error;
			}
			expect((failure as { code?: string })?.code).toBe(
				"temporary_profile_root_invalid",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("browser launch isolation", () => {
	test("temporary modes use a unique profile and dynamic port, then clean it up", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-launch-"));
		const configuredTempRoot = String.raw`C:\Users\test\AppData\Local\Temp\pi-wsl-browser`;
		const config = makeConfig(root, {
			tempProfileRoot: configuredTempRoot,
		});
		const fakeProfile = join(root, "created-profile");
		const launches: Array<{ executable: string; args: string[] }> = [];
		const terminations: string[] = [];
		const manager = createBrowserLaunchManager({
			async launch(executable, args) {
				launches.push({ executable, args });
				return { pid: 55 };
			},
			async terminate({ marker }) {
				terminations.push(marker);
			},
		});
		try {
			const handle = await launchBrowser({
				installation: makeInstallation(),
				mode: "headless",
				sessionKey: "session-key",
				config,
				process: {
					async launch(executable, args) {
						launches.push({ executable, args });
						return { pid: 55 };
					},
					async terminate({ marker }) {
						terminations.push(marker);
					},
				},
				toWslPath: async (path) => {
					expect(path).toBe(configuredTempRoot);
					return "/mnt/c/Users/test/AppData/Local/Temp/pi-wsl-browser";
				},
				toWindowsPath: async (path) => {
					expect(path).toBe(fakeProfile);
					return String.raw`C:\Users\test\AppData\Local\Temp\pi-wsl-browser-profile`;
				},
				ensureTemporaryProfileRoot: async (path) => {
					expect(path).toBe("/mnt/c/Users/test/AppData/Local/Temp/pi-wsl-browser");
				},
				createTemporaryProfile: async (prefix) => {
					expect(prefix).toContain(
						"/mnt/c/Users/test/AppData/Local/Temp/pi-wsl-browser",
					);
					mkdirSync(fakeProfile, { recursive: true });
					return fakeProfile;
				},
				waitForEndpoint: async () => ({
					port: 45_001,
					webSocketPath: "/devtools/browser/temp",
					webSocketUrl: "ws://127.0.0.1:45001/devtools/browser/temp",
					httpUrl: "http://127.0.0.1:45001",
				}),
				random: () => "fixed-token",
			});
			expect(handle.profilePath).toBe(fakeProfile);
			expect(handle.cdpEnvName).toBe("BU_CDP_URL");
			const userDataArg = launches[0]?.args.find((arg) =>
				arg.startsWith("--user-data-dir="),
			);
			expect(userDataArg?.startsWith("--user-data-dir=C:\\") ?? false).toBe(true);
			expect(userDataArg ?? "").not.toContain("\\\\wsl.localhost");
			expect(launches[0]?.args).toContain("--remote-debugging-port=0");
			expect(launches[0]?.args).toContain("--headless=new");
			await manager.close(handle);
			expect(terminations).toEqual([handle.marker]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("never falls back to a WSL-only temporary profile root", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-wsl-temp-"));
		let launched = false;
		let failure: unknown;
		try {
			await launchBrowser({
				installation: makeInstallation(),
				mode: "headless",
				sessionKey: "session-key",
				config: makeConfig(root, { tempProfileRoot: "/tmp" }),
				process: {
					async launch() {
						launched = true;
						return { pid: 55 };
					},
					async terminate() {},
				},
			});
		} catch (error) {
			failure = error;
		}
		expect((failure as { code?: string })?.code).toBe(
			"temporary_profile_root_invalid",
		);
		expect(launched).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	test("main-profile reuses an existing endpoint without launching Edge", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-existing-main-"));
		const data = join(root, "User Data");
		mkdirSync(data, { recursive: true });
		const endpoint = {
			port: 45_004,
			webSocketPath: "/devtools/browser/existing-main",
			webSocketUrl: "ws://127.0.0.1:45004/devtools/browser/existing-main",
			httpUrl: "http://127.0.0.1:45004",
		};
		let launched = false;
		let waited = false;
		try {
			const handle = await launchBrowser({
				installation: { ...makeInstallation(), userDataDir: data },
				mode: "main-profile",
				sessionKey: "existing-main-session",
				config: makeConfig(root),
				process: {
					async launch() {
						launched = true;
						return { pid: 57 };
					},
					async terminate() {},
				},
				toWindowsPath: async (path) => path,
				readEndpoint: async (path) => {
					expect(path).toBe(data);
					return endpoint;
				},
				waitForEndpoint: async () => {
					waited = true;
					return endpoint;
				},
			});
			expect(launched).toBe(false);
			expect(waited).toBe(false);
			expect(handle.cdp).toEqual(endpoint);
			expect(handle.pid).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("shares the main-profile endpoint deadline with the controller", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-endpoint-budget-"));
		const data = join(root, "User Data");
		mkdirSync(data, { recursive: true });
		let now = 0;
		let endpointTimeout: number | undefined;
		const updates: string[] = [];
		const endpoint = {
			port: 45_003,
			webSocketPath: "/devtools/browser/budget",
			webSocketUrl: "ws://127.0.0.1:45003/devtools/browser/budget",
			httpUrl: "http://127.0.0.1:45003",
		};
		try {
			const handle = await launchBrowser({
				installation: { ...makeInstallation(), userDataDir: data },
				mode: "main-profile",
				sessionKey: "budget-session",
				config: makeConfig(root),
				deadline: 10,
				now: () => now,
				process: {
					async launch() {
						return { pid: 57 };
					},
					async terminate() {},
				},
				toWindowsPath: async () => String.raw`C:\Users\test\User Data`,
				readEndpoint: async () => undefined,
				waitForEndpoint: async (_profilePath, options) => {
					endpointTimeout = options.timeoutMs;
					options.onUpdate?.("endpoint pending");
					now += 6;
					return endpoint;
				},
				onUpdate: (message) => updates.push(message),
			});
			expect(handle.cdpEnvName).toBe("BU_CDP_WS");
			expect(endpointTimeout).toBe(10);
			expect(now).toBe(6);
			expect(
				updates.some((message) =>
					message.includes("edge://inspect/#remote-debugging"),
				),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("main-profile cleanup never invokes process termination", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-main-"));
		const data = join(root, "User Data");
		mkdirSync(data, { recursive: true });
		const config = makeConfig(root);
		let terminated = false;
		const manager = createBrowserLaunchManager({
			async launch() {
				return { pid: 56 };
			},
			async terminate() {
				terminated = true;
			},
		});
		try {
			const handle = await launchBrowser({
				installation: { ...makeInstallation(), userDataDir: data },
				mode: "main-profile",
				sessionKey: "main-session",
				config,
				process: {
					async launch() {
						return { pid: 56 };
					},
					async terminate() {
						terminated = true;
					},
				},
				toWindowsPath: async (path) => path,
				readEndpoint: async () => ({
					port: 45_002,
					webSocketPath: "/devtools/browser/main",
					webSocketUrl: "ws://127.0.0.1:45002/devtools/browser/main",
					httpUrl: "http://127.0.0.1:45002",
				}),
				waitForEndpoint: async () => ({
					port: 45_002,
					webSocketPath: "/devtools/browser/main",
					webSocketUrl: "ws://127.0.0.1:45002/devtools/browser/main",
					httpUrl: "http://127.0.0.1:45002",
				}),
				random: () => "fixed-token",
			});
			await manager.close(handle);
			expect(handle.cdpEnvName).toBe("BU_CDP_WS");
			expect(terminated).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("controller lifecycle", () => {
	test("acquire sends marker/profile, writes a secret-free descriptor, and release keeps daemon reusable", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-controller-"));
		const logFile = join(root, "daemon.log");
		writeFileSync(logFile, "daemon diagnostic tail\n");
		const service = new FakeShelldService(logFile);
		const client = new FakeControlClient();
		const controller = makeController(root, client, service);
		try {
			const lease = await controller.acquire("headless");
			expect(lease.leaseId).toBe("lease-1");
			const acquire = client.requests.find(
				(request) => request.action === "acquire-root",
			);
			expect(acquire?.profile).toBe("Profile 2");
			expect(acquire?.marker).toBe("pi-wsl-browser-session-marker");
			const descriptor = JSON.parse(
				readFileSync(controller.descriptorPath, "utf8"),
			);
			expect(descriptor.lease.leaseId).toBe("lease-1");
			expect(descriptor.controlToken).toBeUndefined();
			expect(descriptor.cdpUrl).toBeUndefined();
			expect(descriptor.runtimeDir).toContain("/pi-wsl-browser/sessions/");
			expect(descriptor.tmpDir).toContain("/pi-wsl-browser/sessions/");
			expect(statSync(descriptor.runtimeDir).mode & 0o777).toBe(0o700);
			expect(statSync(descriptor.tmpDir).mode & 0o777).toBe(0o700);
			expect(service.starts[0]?.command).not.toContain("BH_MANAGED_CONTROL_TOKEN");
			expect(service.starts[0]?.command).not.toContain("http://127.0.0.1");
			expect(service.starts[0]?.env?.BH_MANAGED_CONTROL_TOKEN).toBeDefined();
			expect(service.starts[0]?.env?.BH_RUNTIME_DIR).toBe(descriptor.runtimeDir);
			expect(service.starts[0]?.env?.BH_TMP_DIR).toBe(descriptor.tmpDir);
			await controller.retain();
			expect(client.requests.map((request) => request.action)).toEqual([
				"health",
				"acquire-root",
			]);
			expect(controller.activeLease?.retained).toBe(true);
			const reacquired = await controller.acquire("headless");
			expect(reacquired.retained).toBe(true);
			expect(client.requests.map((request) => request.action)).toEqual([
				"health",
				"acquire-root",
				"health",
				"acquire-root",
			]);
			await controller.release();
			expect(client.requests.map((request) => request.action)).toContain(
				"release-root",
			);
			expect(service.closeCalls).toEqual([]);
		} finally {
			await controller.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("main-profile authorization uses one 180-second window and can be cancelled by the clock", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-auth-"));
		const logFile = join(root, "daemon.log");
		writeFileSync(logFile, "waiting for authorization\\n");
		const service = new FakeShelldService(logFile);
		let now = 0;
		let launchDeadline: number | undefined;
		const updates: string[] = [];
		const pendingClient: ControlClientLike = {
			async request<T = Record<string, unknown>>(fields: {
				action: "health" | "acquire-root" | "release-root" | "status" | "shutdown";
				mode?: BrowserMode;
				profile?: string;
				marker?: string;
			}): Promise<ControlResponse<T>> {
				if (fields.action === "health") {
					return {
						ok: false,
						error: {
							code: "authorization_pending",
							message: "waiting for authorization",
						},
					};
				}
				return { ok: true, data: {} as T };
			},
		};
		const controller = new BrowserController({
			session: resolveSessionIdentity({
				sessionFile: join(root, "session.jsonl"),
			}),
			config: makeConfig(root, { authorizationTimeoutMs: 10, pollIntervalMs: 5 }),
			service,
			discovery: { discover: async () => makeInstallation() },
			browser: {
				async launch({ mode, deadline }) {
					launchDeadline = deadline;
					now += 7;
					return makeBrowser(mode);
				},
				async close() {},
			},
			controlClientFactory: () => pendingClient,
			socketPath: join(root, "managed.sock"),
			now: () => now,
			sleep: async (milliseconds) => {
				now += milliseconds;
			},
		});
		try {
			let failure: unknown;
			try {
				await controller.acquire("main-profile", undefined, (message) =>
					updates.push(message),
				);
			} catch (error) {
				failure = error;
			}
			expect((failure as { code?: string })?.code).toBe("authorization_timeout");
			expect(launchDeadline).toBe(10);
			expect(now).toBe(10);
			expect(
				updates.some((message) =>
					message.includes("edge://inspect/#remote-debugging"),
				),
			).toBe(true);
			expect(service.starts).toHaveLength(1);
		} finally {
			await controller.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("managed CDP unavailability stays transient until the startup deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-cdp-pending-"));
		const logFile = join(root, "daemon.log");
		writeFileSync(logFile, "waiting for managed CDP\n");
		const service = new FakeShelldService(logFile);
		let now = 0;
		const healthCalls: number[] = [];
		const client: ControlClientLike = {
			async request<T = Record<string, unknown>>(fields: {
				action: "health" | "acquire-root" | "release-root" | "status" | "shutdown";
				mode?: BrowserMode;
				profile?: string;
				marker?: string;
			}): Promise<ControlResponse<T>> {
				if (fields.action === "health") {
					healthCalls.push(now);
					return {
						ok: false,
						error: {
							code: "managed_cdp_unavailable",
							message: "managed CDP endpoint is not ready",
						},
					};
				}
				return { ok: true, data: {} as T };
			},
		};
		const controller = new BrowserController({
			session: resolveSessionIdentity({
				sessionFile: join(root, "session.jsonl"),
			}),
			config: makeConfig(root, { startupTimeoutMs: 10, pollIntervalMs: 3 }),
			service,
			discovery: { discover: async () => makeInstallation() },
			browser: {
				async launch({ mode }) {
					return makeBrowser(mode);
				},
				async close() {},
			},
			controlClientFactory: () => client,
			socketPath: join(root, "managed.sock"),
			now: () => now,
			sleep: async (milliseconds) => {
				now += milliseconds;
			},
		});
		try {
			let failure: unknown;
			try {
				await controller.acquire("headless");
			} catch (error) {
				failure = error;
			}
			expect((failure as { code?: string })?.code).toBe("daemon_start_timeout");
			expect(now).toBe(10);
			expect(healthCalls.length).toBeGreaterThan(1);
			expect(healthCalls[0]).toBe(0);
		} finally {
			await controller.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("daemon exit is reported with exit code, log path, and log tail", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-exit-"));
		const logFile = join(root, "daemon.log");
		writeFileSync(logFile, "fatal daemon message\n");
		const service = new FakeShelldService(logFile);
		const client = new FakeControlClient();
		const controller = makeController(root, client, service);
		try {
			await controller.acquire("headless");
			service.settle({ code: 17, signal: null });
			await new Promise((resolve) => setTimeout(resolve, 0));
			const status = await controller.status();
			expect(status.error?.code).toBe("daemon_exited");
			expect(status.error?.details?.exitCode).toBe(17);
			expect(status.error?.details?.logPath).toBe(logFile);
			expect(status.error?.details?.logTail).toContain("fatal daemon message");
			let reacquireFailure: unknown;
			try {
				await controller.acquire("headless");
			} catch (error) {
				reacquireFailure = error;
			}
			expect((reacquireFailure as { code?: string })?.code).toBe("daemon_exited");
		} finally {
			await controller.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("same-mode reacquire surfaces a missing managed root", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-root-missing-"));
		const logFile = join(root, "daemon.log");
		writeFileSync(logFile, "root disappeared\\n");
		const service = new FakeShelldService(logFile);
		let acquireCount = 0;
		const client: ControlClientLike = {
			async request<T = Record<string, unknown>>(fields: {
				action: "health" | "acquire-root" | "release-root" | "status" | "shutdown";
				mode?: BrowserMode;
				profile?: string;
				marker?: string;
			}): Promise<ControlResponse<T>> {
				if (fields.action === "health") {
					return { ok: true, data: { ready: true } as T };
				}
				if (fields.action === "acquire-root") {
					acquireCount += 1;
					if (acquireCount === 2) {
						return {
							ok: false,
							error: {
								code: "managed_root_missing",
								message: "the marked root target no longer exists",
							},
						};
					}
					return {
						ok: true,
						data: {
							leaseId: "lease-1",
							rootTargetId: "root-1",
							ownedTargetIds: ["root-1"],
							mode: fields.mode,
						} as T,
					};
				}
				return { ok: true, data: {} as T };
			},
		};
		const controller = makeController(root, client, service);
		try {
			await controller.acquire("headless");
			let failure: unknown;
			try {
				await controller.acquire("headless");
			} catch (error) {
				failure = error;
			}
			expect((failure as { code?: string })?.code).toBe("managed_root_missing");
			expect(controller.activeLease?.rootTargetId).toBe("root-1");
			expect(acquireCount).toBe(2);
		} finally {
			await controller.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("wsl_browser tool", () => {
	test("returns structured results and delegates lifecycle actions without choosing a daemon", async () => {
		const calls: string[] = [];
		const lease: LeaseStatus = {
			leaseId: "tool-lease",
			rootTargetId: "tool-root",
			ownedTargetIds: ["tool-root"],
			mode: "headless",
			retained: false,
		};
		const controller: LifecycleController = {
			activeLease: lease,
			isRetained: false,
			async acquire() {
				calls.push("acquire");
				return lease;
			},
			async retain() {
				calls.push("retain");
				return lease;
			},
			async release() {
				calls.push("release");
				return { released: true };
			},
			async status() {
				calls.push("status");
				return { daemon: { status: "running" }, lease };
			},
			async shutdown() {
				calls.push("shutdown");
			},
		};
		const runtime = createWslBrowserToolRuntime({} as never, {
			service: {} as ShelldServiceV1,
			config: makeConfig("/tmp/agent"),
			createController: () => controller,
		});
		const ctx = {
			cwd: "/tmp",
			sessionManager: { getSessionFile: () => "/tmp/tool-session.jsonl" },
			ui: {},
		};
		const result = await runtime.tool.execute(
			"call",
			{ action: "acquire", mode: "headless" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(result.details?.leaseId).toBe("tool-lease");
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		if (firstContent?.type === "text") {
			expect(firstContent.text).toContain('"ok": true');
		}
		expect(calls).toEqual(["acquire"]);
	});

	test("reports missing pi-shelld as a structured tool error", async () => {
		const runtime = createWslBrowserToolRuntime(
			{ events: { emit() {} } } as never,
			{
				config: makeConfig("/tmp/agent"),
			},
		);
		const ctx = {
			cwd: "/tmp",
			sessionManager: { getSessionFile: () => "/tmp/missing-service.jsonl" },
			ui: {},
		};
		let failure: unknown;
		try {
			await runtime.tool.execute(
				"call",
				{ action: "status" },
				undefined,
				undefined,
				ctx as never,
			);
		} catch (error) {
			failure = error;
		}
		expect(String(failure)).toContain('"ok":false');
		expect(String(failure)).toContain("shelld_unavailable");
	});

	test("logs cleanup failures without rejecting Pi lifecycle events", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-wsl-browser-cleanup-log-"));
		const lease: LeaseStatus = {
			leaseId: "lease",
			rootTargetId: "root",
			ownedTargetIds: ["root"],
			mode: "headless",
			retained: false,
		};
		const controller: LifecycleController = {
			activeLease: lease,
			isRetained: false,
			async acquire() {
				return lease;
			},
			async retain() {
				return lease;
			},
			async release() {
				throw new WslBrowserError("daemon_exited", "managed daemon exited");
			},
			async status() {
				return { daemon: { status: "running" }, lease };
			},
			async shutdown() {
				throw new WslBrowserError(
					"shutdown_failed",
					"one or more browser resources failed to shut down",
					{ failures: ["daemon exited"] },
				);
			},
		};
		const runtime = createWslBrowserToolRuntime({} as never, {
			service: {} as ShelldServiceV1,
			config: makeConfig(root),
			createController: () => controller,
		});
		const ctx = {
			cwd: "/tmp",
			sessionManager: { getSessionFile: () => join(root, "session.jsonl") },
			ui: {},
		};
		try {
			await runtime.tool.execute(
				"call",
				{ action: "status" },
				undefined,
				undefined,
				ctx as never,
			);
			await runtime.agentSettled(ctx as never);
			await runtime.sessionShutdown(ctx as never);
			const logFile = join(root, ".pi-wsl-browser", "log.txt");
			const records = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records).toHaveLength(2);
			expect(records[0]).toMatchObject({
				level: "error",
				event: "lifecycle_cleanup_failed",
				sourceEvent: "agent_settled",
				error: { code: "daemon_exited" },
			});
			expect(records[1]).toMatchObject({
				level: "error",
				event: "lifecycle_cleanup_failed",
				sourceEvent: "session_shutdown",
				error: {
					code: "shutdown_failed",
					details: { failures: ["daemon exited"] },
				},
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("agent-settled policy", () => {
	test("auto-releases ordinary leases but retains explicit retained leases until shutdown", async () => {
		const calls: string[] = [];
		let lease: LeaseStatus | undefined = {
			leaseId: "lease",
			rootTargetId: "root",
			ownedTargetIds: ["root"],
			mode: "headless",
			retained: false,
		};
		let retained = false;
		const controller: LifecycleController = {
			get activeLease() {
				return lease;
			},
			get isRetained() {
				return retained;
			},
			async acquire() {
				return lease!;
			},
			async retain() {
				retained = true;
				return lease!;
			},
			async release() {
				calls.push("release");
				lease = undefined;
				return { released: true };
			},
			async status() {
				return { daemon: { status: "running" } };
			},
			async shutdown() {
				calls.push("shutdown");
				lease = undefined;
			},
		};
		const lifecycle = new BrowserLifecycle({
			createController: () => controller,
			service: {} as ShelldServiceV1,
			config: makeConfig("/tmp/agent"),
			session: resolveSessionIdentity({ sessionId: "test-session" }),
		});
		await lifecycle.autoRelease();
		expect(calls).toEqual(["release"]);
		lease = {
			leaseId: "lease-2",
			rootTargetId: "root",
			ownedTargetIds: ["root"],
			mode: "headless",
			retained: false,
		};
		await lifecycle.retain();
		await lifecycle.autoRelease();
		expect(calls).toEqual(["release"]);
		await lifecycle.shutdown();
		expect(calls).toEqual(["release", "shutdown"]);
	});
});
