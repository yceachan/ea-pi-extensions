#!/usr/bin/env bun
// gcm — 复合 commit message 规范入口（开发者手动运维）。
//
// 把 docs/git提交规范.md 的约定收进一条命令:
//   1. type 词表校验（feat/fix/docs/chore/refactor/test/ci，release 仅脚本生成）
//   2. scope 解析: 包名自动扫描 packages/*，支持模糊搜索 + 二次确认；
//      二级匹配 packages/*/ 下裸根 .ts 小工具并归到母包
//   3. subject 校验: ≤50 字符、小写开头、无 emoji、英文
//   4. 提交卫生: 只提交已显式暂存的内容，绝不替你 git add
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
import { createInterface } from "node:readline";
import {
	compareVersions,
	fuzzyScopeCandidates,
	isValidVersion,
	packageScopes,
	packageVersionLines,
	registryBaseline,
} from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `gcm — 复合 commit message 规范入口（开发者手动运维）

用法:
  bun run gcm -- -t <type> [-p <scope>] -m "<subject>" [--body <body>]
               [--print | --dry] [-y]
  bun run gcm -- --list

参数:
  -t, --type <type>      必填。type 词表: feat | fix | docs | chore | refactor
                         | test | ci（chores 自动归一为 chore）
                         release 禁止手写——只由 mono-release 生成
  -p, --scope <scope>    可选。scope: 包名（自动扫描 packages/*）或跨切面词表
                         scripts/ci/docs/release/changelog/root
                         包名支持模糊搜索，并二级匹配 packages/*/ 下裸根 .ts
                         小工具归到母包（如 cite-wslpath → pi-gadget）
                         非精确命中必须二次确认: TTY 下回车确认首选 / 输入
                         序号或完整包名；非交互需 -y 确认唯一候选
  -m, --message <subject>  必填。主题: 祈使句、小写开头、≤50 字符、无 emoji
  -b, --body <body>      可选。body（非显然变更必写，可含 \\n 换行）
      --print            只打印拼好的提交信息，不执行 git（供 agent/管道使用）
      --dry              验证模式: 走完整校验 + git 可达性检查（在仓库内、
                         暂存区非空），但只回显构造出的完整 git 命令，
                         不产生实际 commit
  -y, --yes              非交互模式: 接受唯一的模糊匹配结果，跳过二次确认
      --list             列出全部 packages@versions（如 pi-gadget@0.2.1）
  -h, --help             显示本帮助

changelog 骨架模式（-c）:
  gcm -c -p <package> [--patch | --minor | --major | --set-ver <vX.Y.Z>]
    创建 changelog/<pkg>/v<ver>/log.md 骨架并打印提交提示（发版前写发布说明）
    只创建文件，不碰 git、不发版；目标版本须高于该包 registry 基线
    -p 必须是 packages/* 中的精确包名；版本参数必填
    推荐工作流: feat 开发完成后先建骨架 → 填写条目 → 代码与 changelog
    一并 git add → gcm -t <type> -p <pkg> 一次提交
    （代码已提交时才走次选: gcm -t docs -p changelog 单独提交）

行为:
  - 提交前要求暂存区非空: 请先显式 git add <path>（规范禁止 add -A / add .）
  - 只提交暂存区内容，存在未暂存改动时仅告警
  - 调用 git commit -m "<type(scope): subject>"，不传 --no-verify
  - --print 与 --dry 同时给出时，--print 优先（纯输出、不碰 git）

示例:
  bun run gcm -- --list                                      # 列出 packages@versions
  bun run gcm -- -t fix -p shelld -m "drain zombie shells on session end"
  bun run gcm -- -t feat -p oc -m "add vision fallback"   # 模糊搜索+交互确认
  bun run gcm -- -t feat -p cite-wslpath -m "x"          # 二级匹配 → pi-gadget
  bun run gcm -- -t docs -m "update README"                # 无 scope
  bun run gcm -- -t fix -p gad -m "x" -y --dry             # 只回显构造的命令
  bun run gcm -- -t chore -m "bump deps" -b "Why: ...\\n  second line"
  bun run gcm -- -t fix -p shelld -m "x" --print           # 只输出提交信息

退出码:
  0  成功（含 --print / --dry 完成）
  1  校验失败 / 交互取消 / git 错误
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
const CROSS_SCOPES = ["scripts", "ci", "docs", "release", "changelog", "root"];

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

function warn(msg) {
	console.warn(`⚠ ${msg}`);
}

// ---- 参数解析 ----

const argv = process.argv.slice(2);
const hasRealArgs = argv.some((a) => {
	const key = a.split("=")[0];
	return (
		VALUE_OPTS[key] !== undefined ||
		["-y", "--yes", "--print", "--dry", "-c", "--changelog", "--list"].includes(a)
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
		opts.changelog
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
		opts.yes
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
					if (compareVersions(v, current) <= 0) {
						fail(`目标 ${v} 不高于本地当前版本 ${current}`);
					}
					return v;
				})()
			: (() => {
					const [major, minor, patch] = current.split(".").map(Number);
					if (opts.mode === "major") return `${major + 1}.0.0`;
					if (opts.mode === "minor") return `${major}.${minor + 1}.0`;
					return `${major}.${minor}.${patch + 1}`;
				})();

	const base = await registryBaseline(`@yceachan/${pkg}`);
	if (base.status === "unreachable") {
		warn("registry 不可达，跳过基线检查");
	} else if (base.status === "ok" && compareVersions(target, base.max) <= 0) {
		fail(`v${target} 不高于 registry 基线 ${base.max}——该版本无需新 changelog`);
	}

	const relChangelogPath = `changelog/${pkg}/v${target}/log.md`;
	const changelogPath = join(root, relChangelogPath);
	if (existsSync(changelogPath)) {
		fail(`已存在，勿覆盖: ${changelogPath}`);
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
	console.log(`    1. 填写 ${relChangelogPath} 条目`);
	console.log(`    2. git add <本次改动的文件> ${relChangelogPath}`);
	console.log(`    3. ./gcm -t <type> -p ${pkg} -m "..."     # 一并提交`);
	console.log("  changelog 路径次选（代码已提交，仅补发布说明）:");
	console.log(`    ./gcm -t docs -p changelog -m "${pkg} v${target}"`);
	const releaseArg =
		opts.mode === "set-ver" ? `--set-ver ${target}` : `--${opts.mode}`;
	console.log(`  随后发版: ./gbump -p ${pkg} ${releaseArg}`);
}

// ---- scope 解析（包名模糊搜索 + 二级小工具匹配 + 二次确认）----

function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(question, (answer) => {
			rl.close();
			res(answer.trim());
		});
	});
}

// 候选展示: 直接命中显示包名，二级小工具命中标注来源文件。
function describeCandidate(c) {
	return c.via ? `${c.scope}（via ${c.via.slice(5)}）` : c.scope;
}

async function resolveScope(input) {
	const exactScopes = [...packageScopes(root), ...CROSS_SCOPES];
	if (exactScopes.includes(input)) return input; // 精确命中: 包名或跨切面词表

	const scored = fuzzyScopeCandidates(input, {
		root,
		crossScopes: CROSS_SCOPES,
	});

	if (scored.length === 0) {
		fail(
			`scope "${input}" 无候选匹配——包名: ${packageScopes(root).join(", ")}；跨切面: ${CROSS_SCOPES.join("/")}`,
		);
	}

	const interactive = process.stdin.isTTY && process.stdout.isTTY;
	if (!interactive) {
		if (scored.length === 1) {
			if (!opts.yes) {
				fail(
					`模糊匹配 "${input}" → ${describeCandidate(scored[0])}（二次确认: 追加 -y 接受）`,
				);
			}
			warn(`模糊匹配 "${input}" → ${describeCandidate(scored[0])}（-y 已确认）`);
			return scored[0].scope;
		}
		fail(
			`模糊匹配 "${input}" 命中多个候选（${scored.map(describeCandidate).join(" / ")}）——请使用完整包名，或 TTY 下交互选择`,
		);
	}

	if (scored.length === 1) {
		const ans = await ask(
			`模糊匹配 "${input}" → 候选 ${describeCandidate(scored[0])}。回车确认 [Y/n] `,
		);
		if (ans === "" || /^y(es)?$/i.test(ans)) return scored[0].scope;
		fail("已取消");
	}

	console.warn(`⚠ 模糊匹配 "${input}" 命中多个候选（回车确认首选）:`);
	for (const [i, c] of scored.entries()) {
		console.log(`  ${i + 1}) ${describeCandidate(c)}`);
	}
	const ans = await ask(
		"回车确认首选 / 输入序号 / 输入完整包名（其他输入取消）: ",
	);
	if (ans === "") return scored[0].scope; // enter = 确认首选
	if (/^\d+$/.test(ans)) {
		const pick = scored[Number(ans) - 1];
		if (pick) return pick.scope;
		fail(`无效序号: ${ans}`);
	}
	if (exactScopes.includes(ans)) return ans; // 输入完整包名精确指定
	fail("已取消");
}

// ---- subject 校验 ----

function validateSubject(subject) {
	if (subject === undefined || subject.trim() === "") fail("-m <主题> 必填");
	if (subject.length > 50) {
		fail(
			`主题 ${subject.length}/50 字符超限（规范: subject 不超过 50 字符）——请精简`,
		);
	}
	if (
		/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(subject) ||
		/\uFE0F/u.test(subject)
	) {
		fail("主题禁止 emoji（规范与 pi AGENTS.md 一致）");
	}
	if (/^[A-Z]/.test(subject)) warn(`主题应以小写开头: "${subject}"`);
	if (/[\u4E00-\u9FFF]/.test(subject))
		warn("提交信息约定为英文，中文主题仅限临时使用");
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
	if (opts.scope !== undefined) scope = await resolveScope(opts.scope);

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
			"暂存区为空——请先显式暂存: git add <path>（规范禁止 git add -A / git add .）",
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
		warn("存在未暂存/未跟踪改动——本次提交只包含暂存区，请确认无夹带:");
		for (const f of [...unstaged, ...untracked].slice(0, 10))
			console.warn(`  ~ ${f}`);
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
		fail("git commit 失败（可能被 hook 拦截）");
	}

	const hash = git(["rev-parse", "--short", "HEAD"], true).trim();
	console.log(`✓ committed ${hash}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
