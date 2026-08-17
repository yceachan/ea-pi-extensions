# pi-gadget v0.2.3

## feat

### pi-cite-wslpath

- agent_end 扫描扩展：除坏 `file://` URI 外，新增检测 markdown 链接目标为 WSL 原生 POSIX 路径的形态（`[label](/home/...)` / `/mnt/c/...`），统一转换并保留原 label。

## fix

### pi-cite-wslpath

- agent_end 自动转换增加磁盘存在性校验：路径不存在时不再渲染不可打开的链接，改以明文标注（label — 文件不存在，未转成链接），与工具层 existsSync 检查对齐。

## Known Issues
- 终端打开时，单击打开file_link只能后台+闪烁提醒，不能让文件占据前台
<!-- 骨架：按 feat / fix / chore / ci / docs 分组填写 "- " 条目 -->
<!-- 推荐: 与代码改动一次提交——git add <改动文件> changelog/pi-gadget/v0.2.3/log.md 后 ./gcm -t <type> -p pi-gadget -m "..." -->
<!-- 次选（代码已提交，仅补发布说明）: ./gcm -t docs -p changelog -m "pi-gadget v0.2.3" -->