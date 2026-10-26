#!/usr/bin/env python3
"""将 pi list 中的 npm 与 mono 本地包导出为可重装的 npm 命令。"""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


TARGET = 'myconfigs/extension_setup.sh'
COMMIT_MESSAGE = 'chore(root): sync Pi extension setup'
PACKAGE_NAME = re.compile(r'(?:@[a-z0-9._-]+/)?[a-z0-9._-]+')


def run(*args, cwd=None):
    return subprocess.run(
        args, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE,
        timeout=120, env={**os.environ, 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0'},
    ).stdout.rstrip('\n')


def render(listing, mono):
    sources = []
    section = None
    for line in listing.splitlines():
        if line in ('User packages:', 'Project packages:'):
            section = line
        elif line == 'No packages installed.':
            section = line
        elif re.match(r'^  \S', line):
            if section != 'User packages:':
                raise ValueError('出现项目级扩展，请在用户主目录运行 pi list')
            sources.append(line[2:].removesuffix(' (filtered)'))
        elif line.strip() and not line.startswith('    '):
            raise ValueError(f'无法识别 pi list 输出：{line}')
    if section is None:
        raise ValueError('pi list 未输出可识别的包清单')

    packages = set()
    for source in sources:
        if source.startswith('npm:'):
            spec = source[4:]
            name = spec.split('@', 2)[1] if spec.startswith('@') else spec.split('@', 1)[0]
            if spec.startswith('@'):
                name = '@' + name
            if not PACKAGE_NAME.fullmatch(name) or not spec or any(c.isspace() for c in spec):
                raise ValueError(f'无效的 npm 包来源：{source}')
        else:
            package_dir = Path(source).expanduser().resolve(strict=True)
            if not package_dir.is_relative_to(mono):
                raise ValueError(f'本地扩展位于 mono 之外：{source}')
            manifest = json.loads((package_dir / 'package.json').read_text())
            spec = manifest['name']
            if not PACKAGE_NAME.fullmatch(spec) or manifest.get('private'):
                raise ValueError(f'本地扩展没有可发布的 npm 包名：{source}')
        packages.add('npm:' + spec)

    commands = '\n'.join('pi install ' + shlex.quote(source) for source in sorted(packages))
    return (
        '#!/usr/bin/env bash\nset -euo pipefail\n\n'
        '# 自动生成：pi list；mono 本地包按 package.json 的 name 转为 npm 包。\n'
        '# 执行本文件前，请先安装 pi 并配置 npm 访问。\n'
        + commands + ('\n' if commands else '')
    )


def sync(repo, content):
    if run('git', 'rev-parse', '--show-toplevel', cwd=repo) != str(repo):
        raise ValueError('--repo 必须指向 Git 仓库根目录')
    branch = run('git', 'branch', '--show-current', cwd=repo)
    if branch != 'main':
        raise ValueError('自动同步仅在 main 分支运行')
    if run('git', 'diff', '--cached', '--name-only', cwd=repo):
        raise ValueError('仓库已有暂存改动，请先处理后再同步')
    # 仅向当前分支已配置的 upstream 推送，失败保留本地提交。
    upstream = run('git', 'rev-parse', '--abbrev-ref', '@{upstream}', cwd=repo)
    remote = run('git', 'config', f'branch.{branch}.remote', cwd=repo)
    remote_ref = run('git', 'config', f'branch.{branch}.merge', cwd=repo)
    run('git', 'fetch', remote, cwd=repo)
    pending = run('git', 'rev-list', f'{upstream}..HEAD', cwd=repo).splitlines()
    for commit in pending:
        subject = run('git', 'show', '-s', '--format=%s', commit, cwd=repo)
        files = run('git', 'diff-tree', '--no-commit-id', '--name-only', '-r', commit, cwd=repo)
        if subject != COMMIT_MESSAGE or files != TARGET:
            raise ValueError(f'存在其他待推送提交 {commit}，请先手动处理')
    run('git', 'merge', '--ff-only', upstream, cwd=repo)

    target = repo / TARGET
    target.parent.mkdir(exist_ok=True)
    if not target.exists() or target.read_text() != content:
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, prefix='.extension-setup-', delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(content)
                file.flush()
                temporary.chmod(0o755)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    changed = subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', TARGET], cwd=repo)
    if changed.returncode not in (0, 1):
        changed.check_returncode()
    if changed.returncode == 1 or run('git', 'ls-files', '--others', '--exclude-standard', '--', TARGET, cwd=repo):
        run('git', 'add', '--', TARGET, cwd=repo)
        print(run('./gcm', '-t', 'chore', '-p', 'root', '-m', 'sync Pi extension setup', '--allow-dirty', cwd=repo))
    if run('git', 'rev-list', f'{upstream}..HEAD', cwd=repo):
        print(run('git', 'push', remote, f'HEAD:{remote_ref}', cwd=repo))
    else:
        print('扩展清单未变化，无需提交或推送。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1], help='mono 仓库根目录')
    parser.add_argument('--print', action='store_true', help='仅输出生成的 shell，不修改仓库')
    args = parser.parse_args()
    repo = args.repo.expanduser().resolve(strict=True)
    listing = run('pi', 'list', cwd=Path.home())
    content = render(listing, repo)
    if args.print:
        print(content, end='')
    else:
        sync(repo, content)


if __name__ == '__main__':
    main()
