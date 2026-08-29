#!/usr/bin/env bun
// gcm — 复合 commit message 规范入口（开发者手动运维）。
//
// 把 docs/git提交规范.md 的约定收进一条命令:
//   1. type 词表校验（feat/fix/docs/chore/refactor/test/ci，release 仅脚本生成）
//   2. scope 解析: 包名自动扫描 packages/*，支持模糊搜索 + 二次确认；
//      二级匹配 packages/*/ 下裸根 .ts 小工具并归到母包
//   3. subject 校验: ≤100 字符、小写开头、无 emoji，语言不限
//   4. 提交卫生: 只提交已显式暂存的内容；未暂存/未跟踪改动会中止并给出
//      git stash -k -u 隔离指引，绝不替你 git add
//   5. --dry: 走完整校验 + 可达性检查，但只回显构造出的命令，不落库
//   6. -c: changelog 骨架模式——创建 changelog/<pkg>/v<ver>/log.md 并打印
//      提交提示: 推荐与代码改动一次提交（gcm -t <type> -p <pkg>），
//      代码已提交时次选 docs(changelog): 单独提交
//   7. --list: 列出全部 packages@versions
//
// 规范: docs/git提交规范.md | 版本仪式: scripts/mono-release.mjs | 发版入口: ./gbump

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareVersions,
	isValidVersion,
	packageScopes,
	packageVersionLines,
	registryBaseline,
	resolvePackageScope,
} from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const colorsAllowed = process.env.NO_COLOR === undefined;
const forceColor = process.env.FORCE_COLOR === "1";
const useHelpColor = colorsAllowed && (process.stdout.isTTY || forceColor);
const useErrorColor = colorsAllowed && (process.stderr.isTTY || forceColor);
const paint = (code, text) =>
	useHelpColor ? `\u001B[${code}m${text}\u001B[0m` : text;
const heading = (text) => paint("1;32", text);
const option = (text) => paint("1;32", text);
const value = (text) => paint("32", text);
const command = (text) => paint("32", text);
const errorText = (text) =>
	useErrorColor ? `\u001B[31m${text}\u001B[0m` : text;
const warningText = (text) =>
	useErrorColor ? `\u001B[33m${text}\u001B[0m` : text;

const HELP = `${heading("gcm")} — commit 与 changelog 工具

${heading("用法")}
  ${command("./gcm")} ${option("-t")} ${value("<type>")} [${option("-p")} ${value("<scope>")}] ${option("-m")} ${value('"<subject>"')} [${option("--body")} ${value("<body>")}]
  ${command("./gcm")} ${option("-c -p")} ${value("<package>")} (${option("--patch | --minor | --major | --set-ver")} ${value("<X.Y.Z>")})
  ${command("./gcm")} ${option("--list")}

${heading("示例")}
  ${command('./gcm -t fix -p pi-shelld -m "drain zombie shells"')}
  ${command('./gcm -t feat -p skills -m "improve diagram rendering"')}
  ${command('./gcm -t fix -p pi-gadget -m "split change" --allow-dirty')}
  ${command("./gcm -c -p pi-gadget --patch")}
  ${command("./gcm --list")}

${heading("参数")}
  ${option("-t, --type")} ${value("<type>")}       feat | fix | docs | chore | refactor | test | ci
  ${option("-p, --scope")} ${value("<scope>")}    包名或 scripts/skills/ci/docs/release/changelog/root
  ${option("-m, --message")} ${value("<text>")}   subject；最多 100 字符，不含 emoji
  ${option("-b, --body")} ${value("<text>")}      commit body
  ${option("-c, --changelog")}       创建 changelog 骨架
  ${option("--patch|--minor|--major")} changelog 目标版本
  ${option("--set-ver")} ${value("<X.Y.Z>")}      指定 changelog 版本
  ${option("--print")}                仅输出 commit message
  ${option("--dry")}                  校验提交，不写入
  ${option("--allow-dirty")}          保留未暂存文件，只提交 staged 文件
  ${option("-y, --yes")}              接受唯一的模糊 scope
  ${option("--list")}                 列出 packages@versions
  ${option("-h, --help")}             显示帮助

${heading("规则")}
  - staged 为空或存在 unmerged 文件时停止。
  - dirty worktree 默认停止；${option("--allow-dirty")} 可继续。
  - changelog 版本不得低于 manifest，也不得重复已发布版本。

${heading("退出码")}  ${value("0")} 成功  ${value("1")} 失败
`;

const VALUE_OPTS = {
	"-t": "type",
	"--type": "type",
	"-p": "scope",
	"--scope": "scope",
	"-m": "message",
	"--message": "message",
	"-b": "body",
	"--body": "body",
};

const MANUAL_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "ci"];
const TYPE_ALIASES = { chores: "chore" };
const CROSS_SCOPES = [
	"scripts",
	"skills",
	"ci",
	"docs",
	"release",
	"changelog",
	"root",
];

function fail(msg) {
	process.stderr.write(`${errorText(`✗ ${msg}`)}\n`);
	process.exit(1);
}

function warn(msg) {
	process.stderr.write(`${warningText(`⚠ ${msg}`)}\n`);
}

// ---- 参数解析 ----

const argv = process.argv.slice(2);
const hasRealArgs = argv.some((a) => {
	const key = a.split("=")[0];
	return (
		VALUE_OPTS[key] !== undefined ||
		[
			"-y",
			"--yes",
			"--print",
			"--dry",
			"--allow-dirty",
			"-c",
			"--changelog",
			"--list",
		].includes(a)
	);
});
if ((argv.includes("--help") || argv.includes("-h")) && !hasRealArgs) {
	console.log(HELP);
	process.exit(0);
}

const opts = {
	type: undefined,
	scope: undefined,
	message: undefined,
	body: undefined,
	yes: false,
	print: false,
	dry: false,
	allowDirty: false,
	changelog: false,
	list: false,
	mode: null, // changelog 模式: "patch" | "minor" | "major" | "set-ver"
	setVer: null,
};

for (let i = 0; i < argv.length; i++) {
	const raw = argv[i];
	if (raw === "-h" || raw === "--help") continue; // 仅用于帮助判定，bun 注入时跳过
	let key = raw;
	let inline;
	const eq = raw.indexOf("=");
	if (raw.startsWith("-") && eq > 0) {
		key = raw.slice(0, eq);
		inline = raw.slice(eq + 1);
	}
	if (key === "-y" || key === "--yes") {
		opts.yes = true;
		continue;
	}
	if (key === "--print") {
		opts.print = true;
		continue;
	}
	if (key === "--dry") {
		opts.dry = true;
		continue;
	}
	if (key === "--allow-dirty") {
		opts.allowDirty = true;
		continue;
	}
	if (key === "-c" || key === "--changelog") {
		opts.changelog = true;
		continue;
	}
	if (key === "--list") {
		opts.list = true;
		continue;
	}
	if (key === "--patch" || key === "--minor" || key === "--major") {
		if (opts.mode !== null) fail(`冲突的版本参数（已有 ${opts.mode}）`);
		opts.mode = key.slice(2);
		continue;
	}
	if (key === "--set-ver") {
		if (opts.mode !== null) fail(`冲突的版本参数（已有 ${opts.mode}）`);
		let value = inline;
		if (value === undefined) {
			value = argv[++i];
			if (value === undefined) fail("--set-ver 需要版本值: --set-ver <vX.Y.Z>");
		}
		opts.setVer = value;
		opts.mode = "set-ver";
		continue;
	}
	const dest = VALUE_OPTS[key];
	if (!dest) fail(`未知参数: ${raw}（gcm --help 查看用法）`);
	let value = inline;
	if (value === undefined) {
		value = argv[++i];
		if (value === undefined) fail(`缺少参数值: ${key} <值>`);
	}
	opts[dest] = value;
}

// --list: 列出全部 packages@versions（纯查询，不与提交参数混用）。
if (opts.list) {
	if (
		opts.type !== undefined ||
		opts.scope !== undefined ||
		opts.message !== undefined ||
		opts.body !== undefined ||
		opts.changelog ||
		opts.allowDirty ||
		opts.mode !== null ||
		opts.yes ||
		opts.print ||
		opts.dry
	) {
		fail("--list 是独立查询，不与 -t/-p/-m/-b/-c 混用（gcm --help 查看用法）");
	}
	for (const line of packageVersionLines(root)) console.log(line);
	process.exit(0);
}

// -c changelog 骨架模式: 独立于提交流程，先行处理。
if (opts.changelog) {
	await changelogMode();
	process.exit(0);
}

// ---- type 校验 ----

if (opts.mode !== null) {
	fail("版本参数仅用于 -c changelog 模式（gcm --help 查看用法）");
}
if (opts.type === undefined) fail("-t <type> 必填（gcm --help 查看词表）");
let type = opts.type;
if (TYPE_ALIASES[type] !== undefined) {
	warn(`"${type}" → 归一为 "${TYPE_ALIASES[type]}"`);
	type = TYPE_ALIASES[type];
}
if (!MANUAL_TYPES.includes(type)) {
	if (type === "release") {
		fail(
			"release 提交禁止手写——只由 mono-release 生成（bun run mono-release -- pi-gadget minor）",
		);
	}
	fail(`未知 type: "${type}"（词表: ${MANUAL_TYPES.join(" | ")}）`);
}

// ---- changelog 骨架模式（-c）----

async function changelogMode() {
	if (
		opts.type !== undefined ||
		opts.message !== undefined ||
		opts.body !== undefined ||
		opts.print ||
		opts.dry ||
		opts.yes ||
		opts.allowDirty
	) {
		fail(
			"-c 只接受 -p <包名> 与版本参数: --patch | --minor | --major | --set-ver <vX.Y.Z>",
		);
	}
	if (opts.scope === undefined) {
		fail(`-c 需要 -p <包名>（可用: ${packageScopes(root).join(", ")}）`);
	}
	const pkg = opts.scope;
	if (!packageScopes(root).includes(pkg)) {
		fail(`无此包: "${pkg}"——可用: ${packageScopes(root).join(", ")}`);
	}
	if (opts.mode === null) {
		fail("-c 需要版本参数: --patch | --minor | --major | --set-ver <vX.Y.Z>");
	}

	const manifestPath = join(root, "packages", pkg, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (err) {
		fail(`无法读取 ${manifestPath}: ${err.message}`);
	}
	const current = manifest.version;
	if (!isValidVersion(current)) fail(`当前版本非法: ${pkg} ${current}`);

	const target =
		opts.mode === "set-ver"
			? (() => {
					const v = opts.setVer;
					if (!isValidVersion(v)) fail(`非法版本: ${v}（期望 X.Y.Z）`);
					if (compareVersions(v, current) < 0) {
						fail(`目标 ${v} 低于本地当前版本 ${current}`);
					}
					return v;
				})()
			: (() => {
					const [major, minor, patch] = current.split(".").map(Number);
					if (opts.mode === "major") return `${major + 1}.0.0`;
					if (opts.mode === "minor") return `${major}.${minor + 1}.0`;
					return `${major}.${minor}.${patch + 1}`;
				})();

	const relChangelogPath = `changelog/${pkg}/v${target}/log.md`;
	const changelogPath = join(root, relChangelogPath);
	if (existsSync(changelogPath)) {
		fail(`已存在，勿覆盖: ${relChangelogPath}\n  vim ${relChangelogPath}`);
	}

	const base = await registryBaseline(`@yceachan/${pkg}`);
	if (base.status === "unreachable") {
		warn("registry 不可达，跳过基线检查");
	} else if (base.status === "ok" && compareVersions(target, base.max) <= 0) {
		fail(`v${target} 不高于 registry 基线 ${base.max}——该版本无需新 changelog`);
	}
	mkdirSync(dirname(changelogPath), { recursive: true });
	writeFileSync(
		changelogPath,
		[
			`# ${pkg} v${target}`,
			"",
			"## feat",
			"",
			"## fix",
			"",
			'<!-- 骨架：按 feat / fix / chore / ci / docs 分组填写 "- " 条目 -->',
			`<!-- 推荐: 与代码改动一次提交——git add <改动文件> ${relChangelogPath} 后 ./gcm -t <type> -p ${pkg} -m "..." -->`,
			`<!-- 次选（代码已提交，仅补发布说明）: ./gcm -t docs -p changelog -m "${pkg} v${target}" -->`,
			"",
		].join("\n"),
	);
	console.log(`✓ created ${changelogPath}`);
	console.log("");
	console.log(
		"  推荐工作流（feat 开发完成、尚未提交——一次提交包含代码 + changelog）:",
	);
	console.log(`    1. vim ${relChangelogPath}`);
	console.log(`    2. git add <本次改动的文件> ${relChangelogPath}`);
	console.log(`    3. ./gcm -t <type> -p ${pkg} -m "..."     # 一并提交`);
	console.log("  changelog 路径次选（代码已提交，仅补发布说明）:");
	console.log(`    ./gcm -t docs -p changelog -m "${pkg} v${target}"`);
	if (base.status === "unknown") {
		console.log("  registry 尚无此包；首次发布干跑:");
		console.log(`    ./gbump -p ${pkg} --initial --dry-run`);
		console.log(`  确认发布物后执行: ./gbump -p ${pkg} --initial`);
	} else if (base.status === "unreachable") {
		console.log("  registry 状态未知；网络恢复后重新确认首次发布:");
		console.log(`    ./gbump -p ${pkg} --initial --dry-run`);
	} else {
		const releaseArg =
			opts.mode === "set-ver" ? `--set-ver ${target}` : `--${opts.mode}`;
		console.log(`  随后发版: ./gbump -p ${pkg} ${releaseArg}`);
	}
}

// ---- scope 解析（包名模糊搜索 + 二级小工具匹配 + 二次确认）----
// 实现共享于 scripts/lib.mjs 的 resolvePackageScope（gbump -p 同用一份）。

// ---- subject 校验 ----

function validateSubject(subject) {
	if (subject === undefined || subject.trim() === "") fail("-m <主题> 必填");
	if (subject.length > 100) {
		fail(
			`主题 ${subject.length}/100 字符超限（规范: subject 不超过 100 字符）——请精简`,
		);
	}
	if (
		/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(subject) ||
		/\uFE0F/u.test(subject)
	) {
		fail("主题禁止 emoji（规范与 pi AGENTS.md 一致）");
	}
	if (/^[A-Z]/.test(subject)) warn(`主题应以小写开头: "${subject}"`);
}

// ---- 提交 ----

function git(args, quiet = false) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
	});
}

// shell 可执行回显: 双引号包裹，转义内部引号/反斜杠/$/反引号
function quoteShell(arg) {
	return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

async function main() {
	let scope;
	if (opts.scope !== undefined)
		scope = await resolvePackageScope(opts.scope, {
			root,
			crossScopes: CROSS_SCOPES,
			yes: opts.yes,
			fail,
			warn,
		});

	validateSubject(opts.message);
	const composed =
		scope === undefined
			? `${type}: ${opts.message}`
			: `${type}(${scope}): ${opts.message}`;

	if (opts.print) {
		console.log(composed);
		if (opts.body) console.log(`\n${opts.body}`);
		return;
	}

	try {
		git(["rev-parse", "--is-inside-work-tree"], true);
	} catch {
		fail("当前目录不在 git 仓库内");
	}

	let staged;
	try {
		staged = git(["diff", "--cached", "--name-only"], true)
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		fail("git diff --cached 失败");
	}
	if (staged.length === 0) {
		fail(
			"暂存区为空——暂存改动: git status ; git add <path>",
		);
	}

	const unmerged = [
		...new Set(
			git(["ls-files", "-u"], true)
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("\t").at(-1)),
		),
	];
	if (unmerged.length > 0) {
		fail(
			[
				"存在未解决的合并冲突，禁止 commit 或 stash:",
				...unmerged.map((f) => `  ! unmerged: ${f}`),
				"",
				"  git status",
				"  解决后 git add <path>；或按当前操作执行 git rebase --abort / git merge --abort / git cherry-pick --abort",
			].join("\n"),
		);
	}

	const unstaged = git(["diff", "--name-only"], true)
		.trim()
		.split("\n")
		.filter(Boolean);
	const untracked = git(["ls-files", "--others", "--exclude-standard"], true)
		.trim()
		.split("\n")
		.filter(Boolean);
	if (unstaged.length > 0 || untracked.length > 0) {
		const dirtyLines = [
			...unstaged.map((f) => `  ~ tracked: ${f}`),
			...untracked.map((f) => `  ? untracked: ${f}`),
		];
		if (!opts.allowDirty) {
			const retry = `./gcm ${argv.map(quoteShell).join(" ")}`;
			const escape = `${retry} --allow-dirty`;
			fail(
				[
					"工作区包含未纳入本次提交的改动",
					...dirtyLines,
					"",
					"  ==请确认本次应提交文件均已tracked",
					"  ==stash SOP==",
					`  [none]：stash所有tracked diff ;-k 保留staged diff ；-u :额外stash untracked iff:`,
					"  ====",
					'  git stash push -k -u -m "gcm: isolate unstaged work"',
					`  ${retry}`,
					"  git stash pop",
					"",
					"Force Commit --allow-dirty:",
					`  ${escape}`,
				].join("\n"),
			);
		}
		warn(
			[
				"--allow-dirty: 下列改动保留在工作区，不进入本次提交:",
				...dirtyLines,
				"依赖整个工作区的 hook/测试仍可能读取这些改动。",
			].join("\n"),
		);
	}

	console.log(`本次提交 ${staged.length} 个文件:`);
	for (const f of staged) console.log(`  + ${f}`);

	const commitArgs = ["commit", "-m", composed];
	if (opts.body) commitArgs.push("-m", opts.body);

	if (opts.dry) {
		console.log(`[dry] git ${commitArgs.map(quoteShell).join(" ")}`);
		console.log("[dry] 校验与可达性检查已通过，未执行任何写操作");
		return;
	}

	console.log(`→ git ${commitArgs.map(quoteShell).join(" ")}`);
	try {
		git(commitArgs);
	} catch {
		fail(
			"git commit 失败（可能被 hook 拦截）。保留现场；运行 git status，修复 hook 输出并重新 git add <path> 后重试。",
		);
	}

	const hash = git(["rev-parse", "--short", "HEAD"], true).trim();
	console.log(`✓ committed ${hash}`);
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`${errorText(message)}\n`);
	process.exit(1);
});
