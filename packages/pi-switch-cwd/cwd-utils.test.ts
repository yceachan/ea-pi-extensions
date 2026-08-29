// Unit tests for the pure helpers in cwd-utils.ts. Run with: bun run test
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildMovedSessionFile,
	completeDirectories,
	defaultSessionDirFor,
	resolveTargetPath,
	shortenPath,
} from "./cwd-utils.ts";

// Bun resolves os.homedir() from HOME at process startup. Re-run this file in
// a child process with an isolated HOME so tilde tests never touch user files.
const ISOLATED_HOME_ENV = "PI_SWITCH_CWD_TEST_ISOLATED_HOME";
if (process.env[ISOLATED_HOME_ENV] !== "1") {
	const harnessRoot = mkdtempSync(join(tmpdir(), "pi-switch-cwd-harness-"));
	const isolatedHome = join(harnessRoot, "home");
	mkdirSync(isolatedHome, { recursive: true });
	let status = 1;
	try {
		const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
			stdio: "inherit",
			env: {
				...process.env,
				HOME: isolatedHome,
				[ISOLATED_HOME_ENV]: "1",
			},
		});
		if (child.error) console.error(child.error);
		status = child.status ?? 1;
	} finally {
		rmSync(harnessRoot, { recursive: true, force: true });
	}
	process.exit(status);
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  ok  ${name}`);
	} else {
		failures++;
		console.log(
			`FAIL  ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
		);
	}
}

const home = homedir();

// --- shortenPath ---
check("shortenPath home", shortenPath(home), "~");
check("shortenPath under home", shortenPath(join(home, "work/x")), "~/work/x");
check("shortenPath outside home", shortenPath("/tmp/x"), "/tmp/x");

// --- resolveTargetPath ---
check("relative", resolveTargetPath("src", "/a/b"), "/a/b/src");
check("absolute", resolveTargetPath("/x/y", "/a/b"), "/x/y");
check("tilde", resolveTargetPath("~", "/a/b"), home);
check("tilde-slash", resolveTargetPath("~/p", "/a/b"), join(home, "p"));

// --- defaultSessionDirFor ---
const encoded = "--home-pi-work-x--";
check(
	"session dir encoding",
	defaultSessionDirFor("/home/pi/work/x", "/home/pi/.pi/agent"),
	join("/home/pi/.pi/agent", "sessions", encoded),
);

// --- buildMovedSessionFile ---
const root = mkdtempSync(join(tmpdir(), "pi-switch-cwd-test-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const srcCwd = join(root, "src");
const dstCwd = join(root, "dst");
const agentDir = join(root, "agent");
mkdirSync(srcCwd, { recursive: true });
const header = {
	type: "session",
	version: 3,
	id: "abc",
	timestamp: "2025-01-01T00:00:00.000Z",
	cwd: srcCwd,
	parentSession: "/old/parent.jsonl",
	customField: "preserved",
};
const body = [
	{ type: "user", content: "hi", timestamp: "2025-01-01T00:00:01.000Z" },
	{
		type: "assistant",
		content: "hello",
		timestamp: "2025-01-01T00:00:02.000Z",
	},
];

const fileName = "2025-01-01T00-00-00-000Z_abc.jsonl";
const moved = buildMovedSessionFile(header, body, dstCwd, agentDir, fileName);
check(
	"moved file lands in dst session dir",
	moved,
	join(
		root,
		"agent",
		"sessions",
		defaultSessionDirFor(dstCwd, agentDir).split("/").pop()!,
		fileName,
	),
);
const movedText = readFileSync(moved, "utf8");
const movedLines = movedText.split("\n");
const movedHeader = JSON.parse(movedLines[0]);
check("header cwd rewritten", movedHeader.cwd, dstCwd);
check("header id preserved", movedHeader.id, "abc");
check("header custom field preserved", movedHeader.customField, "preserved");
check(
	"body entries preserved",
	movedLines.slice(1).join("\n"),
	`${body.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);

// --- buildMovedSessionFile rejects bad headers ---
let threw = false;
try {
	buildMovedSessionFile({ type: "session" }, body, dstCwd, agentDir, fileName);
} catch {
	threw = true;
}
check("missing cwd in header throws", threw, true);

// --- completeDirectories ---
const base = join(root, "base");
mkdirSync(join(base, "alpha"), { recursive: true });
mkdirSync(join(base, "alpha-sub"), { recursive: true });
mkdirSync(join(base, "beta"), { recursive: true });
mkdirSync(join(base, ".hidden"), { recursive: true });
mkdirSync(join(base, "alpha", "inner"), { recursive: true });
writeFileSync(join(base, "file.txt"), "x");

const all = completeDirectories("", base).map((item) => item.value);
check("empty prefix lists dirs only, sorted", all, [
	"alpha/",
	"alpha-sub/",
	"beta/",
]);
const dotHidden = completeDirectories(".", base).map((item) => item.value);
check("dot prefix reveals hidden", dotHidden, [".hidden/"]);
const alpha = completeDirectories("alpha", base).map((item) => item.value);
check("segment prefix match", alpha, ["alpha/", "alpha-sub/"]);
const alphaSlash = completeDirectories("alpha/", base).map(
	(item) => item.value,
);
check("trailing slash lists children", alphaSlash, ["alpha/inner/"]);
const none = completeDirectories("zzz", base);
check("no match", none, []);
check("nonexistent parent", completeDirectories("nope/x", base), []);

// --- tilde completion ---
const completionDir = join(home, "tmp-completion-test");
mkdirSync(completionDir, { recursive: true });
const tilde = completeDirectories("~/tmp-completion", base).map(
	(item) => item.value,
);
check("tilde completion stays in ~ form", tilde, ["~/tmp-completion-test/"]);
const bareTilde = completeDirectories("~", base).some(
	(item) => item.value === "~/tmp-completion-test/",
);
check("bare ~ lists home", bareTilde, true);

console.log(
	failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
