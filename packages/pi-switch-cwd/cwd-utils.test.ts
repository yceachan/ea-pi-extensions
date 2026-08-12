/**
 * Unit tests for the pure helpers in cwd-utils.ts.
 * Run with: node cwd-utils.test.ts  (node >= 23.6, type stripping)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	buildMovedSessionFile,
	completeDirectories,
	defaultSessionDirFor,
	resolveTargetPath,
	shortenPath,
} from "./cwd-utils.ts";

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

// --- shortenPath ---
check("shortenPath home", shortenPath("/home/pi"), "~");
check("shortenPath under home", shortenPath("/home/pi/work/x"), "~/work/x");
check("shortenPath outside home", shortenPath("/tmp/x"), "/tmp/x");

// --- resolveTargetPath ---
check("relative", resolveTargetPath("src", "/a/b"), "/a/b/src");
check("absolute", resolveTargetPath("/x/y", "/a/b"), "/x/y");
check("tilde", resolveTargetPath("~", "/a/b"), process.env.HOME);
check("tilde-slash", resolveTargetPath("~/p", "/a/b"), `${process.env.HOME}/p`);

// --- defaultSessionDirFor ---
const encoded = "--home-pi-work-x--";
check(
	"session dir encoding",
	defaultSessionDirFor("/home/pi/work/x", "/home/pi/.pi/agent"),
	join("/home/pi/.pi/agent", "sessions", encoded),
);

// --- buildMovedSessionFile ---
const root = join(tmpdir(), `pi-switch-cwd-test-${process.pid}`);
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
	`${body.map((e) => JSON.stringify(e)).join("\n")}\n`,
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

const all = completeDirectories("", base).map((i) => i.value);
check("empty prefix lists dirs only, sorted", all, [
	"alpha/",
	"alpha-sub/",
	"beta/",
]);
const dotHidden = completeDirectories(".", base).map((i) => i.value);
check("dot prefix reveals hidden", dotHidden, [".hidden/"]);
const alpha = completeDirectories("alpha", base).map((i) => i.value);
check("segment prefix match", alpha, ["alpha/", "alpha-sub/"]);
const alphaSlash = completeDirectories("alpha/", base).map((i) => i.value);
check("trailing slash lists children", alphaSlash, ["alpha/inner/"]);
const none = completeDirectories("zzz", base);
check("no match", none, []);
check("nonexistent parent", completeDirectories("nope/x", base), []);

// tilde completion
const home = process.env.HOME ?? "";
mkdirSync(join(home, "tmp-completion-test"), { recursive: true });
const tilde = completeDirectories("~/tmp-complet", base).map((i) => i.value);
check("tilde completion stays in ~ form", tilde, ["~/tmp-completion-test/"]);
const bareTilde = completeDirectories("~", base).some(
	(i) => i.value === "~/tmp-completion-test/",
);
check("bare ~ lists home", bareTilde, true);

// cleanup
rmSync(root, { recursive: true, force: true });
rmSync(join(home, "tmp-completion-test"), { recursive: true, force: true });

console.log(
	failures === 0 ? "\nAll tests passed" : `\n${failures} test(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
