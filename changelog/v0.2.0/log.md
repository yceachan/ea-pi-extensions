# v0.2.0

pi-gadget 新增 `pi-cite-wslpath` 工具：WSL 路径 → Windows Terminal 可点击超链接文本。

## feat

- pi-gadget：`pi-cite-wslpath` 工具
  - 把原生（WSL）路径转换为 WT 可打开的文件 URI：`/mnt/<drive>/...` → `file:///<DRIVE>:/...`（drvfs 即真实 Windows 盘），其余 Linux 路径 → `file://wsl.localhost/<distro>/...`（9P 桥，WT ≥ 1.17）
  - 幂等透传：`C:\...`、`file://`、`\\wsl.localhost\...` 形式原样可用；非 WSL 环境回退标准 `file://` URI；WSL 无 distro 名时回退不产出畸形链接
  - 返回三种可互换形态：`osc8`（裸 OSC 8 序列，写流即注册、模型流式输出期间即可点击）、`markdown`（`[label](uri)`，pi 渲染为 OSC 8）、`uri`（纯文本兜底）
  - 工具参数支持自定义 label、输出形态筛选；promptGuidelines 约束模型先调用工具再引用文件路径、禁止裸 `file:///home/...` 链接
  - 包元数据同步：description、keywords（wslpath/cite/osc8）、files 白名单、pi.extensions 清单纳入新工具
