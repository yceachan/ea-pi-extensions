#!/usr/bin/env bun
// sync-readme — 维护 README.md / README.zh-CN.md 的包清单表格与安装块（开发者手动运维）。
//
// 结构以 zh README（README.zh-CN.md）为准：英文章节标题、逐包 gallery 链接。
// 只动两个 README 的「包清单」表格与「安装」代码块（其余章节一概不碰）:
//   1. 包清单取 packages/* 实际目录（复用 lib.mjs 的 packageScopes，字典序）
//   2. 表格行逐包生成: 包名链接到 packages/<pkg>，gallery 链接到该包的
//      pi.dev 页面 https://pi.dev/packages/@yceachan/<pkg>
//   3. 说明列脚本不拥有: 既有行原样搬移 README 里手工维护的描述（zh 中文 /
//      en 手工描述）；新包回退 package.json 的 description。无译稿层
//   4. 安装代码块逐包生成 pi install npm:@yceachan/<pkg> 行
// 用法:
//   ./sync-readme             # 重建并写入两个 README
//   ./sync-readme --dry       # 只预览，不落盘
//   ./sync-readme --check     # 门禁: 一致 → 输出 "on date" 退出 0；过期 →
//                             # 输出 "out of date" 退出 1（bump 流程前置检查）
//
// 规范: docs/git提交规范.md | 复用: scripts/lib.mjs（packageScopes）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageScopes } from "./lib.mjs";

// 比较/写入门槛：连续空行折叠（>=2 个空行按 1 个算）。
// 包清单表格/安装块的实质内容是行序列；段落间空行数是排版偏好，
// 不参与“on date / out of date”判定——用户已在仓里手工排版的
// README（如 zh 表格后双空行）不会被脚本改写。
const normalize = (s) => s.replace(/\n{3,}/g, "\n\n");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(root, "README.md");
const README_ZH = join(root, "README.zh-CN.md");

const GALLERY = (pkg) => `https://pi.dev/packages/@yceachan/${pkg}`;
const INSTALL_LINE = (pkg) => `pi install npm:@yceachan/${pkg}`;

const FILES = [
	{
		path: README,
		label: "README.md",
		headers: ["| Package | Description | Gallery |", "| --- | --- | --- |"],
	},
	{
		path: README_ZH,
		label: "README.zh-CN.md",
		headers: ["| 包 | 说明 | Gallery |", "| --- | --- | --- |"],
	},
];

// 章节标题两个文件一致（zh README 新结构采用英文标题）。
const PACKAGES_HEADING = "## Packages";
const INSTALL_HEADING = "## Install";

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

// 说明列兜底来源: package.json 的 description（仅新包使用）。
function manifestDescription(pkg) {
	try {
		const desc = JSON.parse(
			readFileSync(join(root, "packages", pkg, "package.json"), "utf8"),
		).description;
		if (typeof desc === "string" && desc.trim() !== "") return desc.trim();
	} catch {
		// 无 package.json 或字段缺失
	}
	return pkg;
}

// 解析既有表格行: pkg -> { desc, gallery }——说明列原样搬移（脚本不拥有描述）。
// 只匹配既有行格式，不匹配即视为无既有行（新包，用 package.json 兜底）。
function existingRows(text) {
	const rows = new Map();
	const inSection = text.split(PACKAGES_HEADING)[1];
	if (inSection === undefined) return rows;
	const section = inSection.split(/\n#{1,6} /)[0];
	for (const line of section.split("\n")) {
		const m = line.match(
			/^\| \[`@yceachan\/([a-z0-9-]+)`\]\((packages\/[^)]+)\) \| (.*) \| \[pi\.dev\]\(([^)]*)\) \|$/,
		);
		if (m) rows.set(m[1], { desc: m[3], gallery: m[4] });
	}
	return rows;
}

// 重建包清单段落（含表头与分隔行，末尾留一个空行再接下一章节）。
function buildPackagesSection(pkgs, existing, cfg) {
	const esc = (s) => s.replace(/\|/g, "\\|");
	const descFor = (pkg) =>
		existing.has(pkg) ? existing.get(pkg).desc : manifestDescription(pkg);
	const body = pkgs.map((pkg) => {
		const name = `\`@yceachan/${pkg}\``;
		return `| [${name}](packages/${pkg}) | ${esc(descFor(pkg))} | [pi.dev](${GALLERY(pkg)}) |`;
	});
	return (
		`${PACKAGES_HEADING}\n\n` +
		[cfg.headers[0], cfg.headers[1], ...body].join("\n") +
		"\n\n"
	);
}

// 重建安装代码块内容（不含围栏）。
function buildInstallLines(pkgs) {
	return pkgs.map(INSTALL_LINE).join("\n");
}

// 替换「安装」标题下包含 pi install 行的首个 bash 围栏块；没有则原地插入。
function replaceInstallBlock(text, installLines) {
	const start = text.indexOf(INSTALL_HEADING);
	if (start === -1) fail(`缺少 ${INSTALL_HEADING} 章节，无法更新安装块`);
	const headingEnd = start + INSTALL_HEADING.length;
	const after = text.slice(headingEnd);
	const nextHeading = after.search(/\n#{1,6} /);
	const sectionEnd = nextHeading === -1 ? after.length : nextHeading + 1;
	const section = after.slice(0, sectionEnd);

	const fenceRe = /```(?:bash)?\n([\s\S]*?)```/;
	const m = section.match(fenceRe);
	let patchedSection;
	if (m && m[1].includes("pi install")) {
		patchedSection =
			section.slice(0, m.index) +
			"```bash\n" +
			installLines +
			"\n```" +
			section.slice(m.index + m[0].length);
	} else {
		patchedSection = "\n```bash\n" + installLines + "\n```\n" + section;
	}
	return (
		text.slice(0, headingEnd) +
		patchedSection +
		text.slice(headingEnd + sectionEnd)
	);
}

// 重建整份 README 的包清单表格与安装块，返回 patch 后的全文。
function patchReadme(text, pkgs, cfg) {
	const tableStart = text.indexOf(PACKAGES_HEADING);
	if (tableStart === -1) fail(`${cfg.label} 缺少 ${PACKAGES_HEADING}，无法重建`);
	const after = text.slice(tableStart + PACKAGES_HEADING.length);
	const nextHeading = after.search(/\n#{1,6} /);
	const sectionEnd = nextHeading === -1 ? after.length : nextHeading + 1;

	const newSection = buildPackagesSection(pkgs, existingRows(text), cfg);
	const withTable =
		text.slice(0, tableStart) + newSection + after.slice(sectionEnd);
	return replaceInstallBlock(withTable, buildInstallLines(pkgs));
}

function main() {
	const args = process.argv.slice(2);
	const bad = args.filter((a) => a !== "--dry" && a !== "--check");
	if (bad.length) fail(`未知参数: ${bad.join(" ")}——支持 --dry / --check`);
	const dry = args.includes("--dry");
	const check = args.includes("--check");
	if (dry && check) fail("--dry 与 --check 互斥");

	const pkgs = packageScopes(root);
	if (pkgs.length === 0) fail("packages/ 下没有包，拒绝重建");

	const results = [];
	for (const cfg of FILES) {
		if (!existsSync(cfg.path)) fail(`缺失: ${cfg.path}`);
		const text = readFileSync(cfg.path, "utf8");
		const patched = patchReadme(text, pkgs, cfg);
		results.push({
			cfg,
			text,
			patched,
			upToDate: normalize(patched) === normalize(text),
		});
	}

	if (check) {
		const stale = results.filter((r) => !r.upToDate);
		if (stale.length === 0) {
			console.log("on date");
			return;
		}
		for (const r of stale) console.error(`  out of date: ${r.cfg.label}`);
		console.log("out of date");
		process.exit(1);
	}

	for (const r of results) {
		if (r.upToDate) {
			console.log(`✓ ${r.cfg.label} 无变化`);
			continue;
		}
		if (dry) {
			console.log(
				`(dry) ${r.cfg.label} 将重建（表格 ${pkgs.length} 包、安装块 ${pkgs.length} 条）`,
			);
			continue;
		}
		writeFileSync(r.cfg.path, r.patched);
		console.log(`✓ 已写入 ${r.cfg.label}`);
	}
}

main();
