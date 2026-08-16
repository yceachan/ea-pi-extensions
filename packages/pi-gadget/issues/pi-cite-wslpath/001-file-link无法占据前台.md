---
title: file 链接无法占据前台
tags: [pi-gadget, pi-cite-wslpath, windows, wsl, foreground]
desc: 点击 wsl.localhost file 链接后目标应用在后台打开、任务栏闪烁，根因是 Windows 前台激活权限机制，gadget 层无解
update: 2026-08-17
---

# file 链接无法占据前台

> [!note]
> **Ref:** [TerminalPage.cpp（WT 超链接处理）](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/TerminalPage.cpp) | [SetForegroundWindow（前台激活条件）](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) | [Foreground activation permission is like love（The Old New Thing）](https://devblogs.microsoft.com/oldnewthing/20090220-00/?p=19083) | [ForegroundLockTimeout 默认值](https://www.damirscorner.com/blog/posts/20060603-ProblemsWithSetForegroundWindowCalls.html)

## 现象

点击 pi 交付的 `file://wsl.localhost/...` 链接（OSC 8 / markdown 渲染），目标文件在默认应用中打开，但窗口出现在后台、不获焦点，任务栏按钮闪烁。三个批量 cite 中前两个正常打开、第三个因文件名错误（深究 vs 触发源）无法打开，均为独立问题；本文只记录前台问题。

## 机制

### Windows 前台锁：焦点不能偷，只能被授予

`SetForegroundWindow` 只有在满足条件时才生效（MS Learn Remarks）：

- 前提：桌面应用；前台进程未调用 `LockSetForegroundWindow`；无菜单激活
- 附加条件至少其一：① 前台锁超时已过期 ② 调用进程是前台进程 ③ **调用进程由前台进程启动** ④ 当前无前台窗口 ⑤ 调用进程收到最后一次输入 ⑥ 处于调试中

不满足时，窗口在后台创建，**任务栏按钮闪烁**代替抢焦点（"An application cannot force a window to the foreground while the user is working with another window. Instead, Windows flashes the taskbar button."）。

放大因素：

- `ForegroundLockTimeout` 默认 **200000 ms**：最近一次用户输入后 200 秒内，后台进程一律无权激活
- **Windows 11 上 `SPI_GETFOREGROUNDLOCKTIMEOUT` 恒为 2147483647（≈无限）**：锁近乎永久生效

### Windows Terminal 只做裸 ShellExecute

`TerminalPage.cpp` `_OpenHyperlinkHandler`：

```cpp
if (shouldLaunch) {
    ShellExecuteW(nullptr, L"open", uriString.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}
```

- `hwnd` 为 `nullptr`，无 `SetForegroundWindow` / `AllowSetForegroundWindow` 担保，无激活逻辑
- `SW_SHOWNORMAL` 只请求"正常显示"，**显示 ≠ 获得焦点**
- 前台与否完全交给 Windows 激活规则与目标应用

### 打开链为何断裂（后台打开的实因）

| 情形 | 结果 |
| --- | --- |
| 目标应用已在运行（单实例 IPC 转发） | 无新进程诞生，"由前台进程启动"不成立；已有实例收到请求后多数不主动激活 |
| 文件关联经 DDE/COM 间接激活 | 真正建窗口的进程不是 ShellExecute 的直接子进程，前台权未授予 |
| 目标应用自身策略 | 部分查看器/编辑器刻意"启动不抢焦点" |
| `wsl.localhost` 是 UNC 网络路径 | `\\wsl.localhost\...` 走网络命名空间解析，间接层更多 |

## GUI 应用做到"点链接即前台"的三种机制

浏览器、编辑器等应用能一边最大化一边让点开的链接占据前台，靠的是以下机制，与窗口是否最大化无关：

1. **进程内处理**：链接在发起方自己的进程内消化（浏览器新 tab、编辑器新 buffer）。新窗口本就属于前台进程，无需跨进程激活——这是"总是能前台"最常见的原因。
2. **直接子进程 + 归因链**：前台进程 `CreateProcess`/`ShellExecute` 直接启动目标，目标满足"由前台进程启动"，创建窗口后调用 `SetForegroundWindow` 即成功。
3. **单实例担保（`AllowSetForegroundWindow`）**：应用已在运行时，启动的 stub（直接子进程、持有前台权）对已有实例担保（"他跟我一伙"），已有实例再激活。COM 场景对应 `CoAllowSetForegroundWindow`。约束：担保者自己必须持有前台权（"不能给出不属于你的东西"）——启动链经 DDE/COM/网络提供者断裂时，担保失效。

浏览器在两条路径上都实现完整：站内点击走进程内处理；外部启动走 stub 担保。WT 的裸 `ShellExecuteW` 两条都没有，目标端再叠加"已有实例转发 / DDE-COM 间接激活 / 查看器不抢焦点"，后台打开即成为常态。

## 结论

- 链接（OSC 8 / file URI）无法表达"强制前台"，打开动作完全由 ShellExecute + 前台规则决定，**gadget 层无解，也不应解**（绕过即焦点窃取）
- 系统侧可选放宽：`HKCU\Control Panel\Desktop\ForegroundLockTimeout = 0`（Win11 生效性存疑）；编辑器侧可选"始终新窗口打开"
- 验证方法：完全退出目标编辑器再点链接，冷启动通常能到前台；已有实例时任务栏闪烁是 Windows 的"通知但不打断"语义
