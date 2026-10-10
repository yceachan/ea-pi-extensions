# pi-quiet v0.4.2

## feat

- 新增 @yceachan/pi-quiet，fork 自 @zenspc/pi-quiet 0.4.1 的 npm 发布包，保留 MIT 许可证、原始版权与上游历史。
- 保留紧凑工具行、动词分组、/quiet 偏好与原始输出展开；复用现有 quiet.json 配置。

## fix

- 按 Pi 1.1 的 `(toolName, next)` 接口获取工具名和下游渲染器，修复 read、bash、codemode 和扩展工具显示 undefined。
- 保留下游 renderShell / renderCall / renderResult，使 quiet off 和展开继续使用原有工具渲染器。
- 直接采用 Pi 公共 resolver 类型，并从渲染器推导上下文类型，避免自定义接口静默偏离宿主。
- 删除依赖上游 monorepo 布局的 prepack / postpack 脚本，避免打包时覆盖原始许可证。

## test

- 在包 scripts.test 注册 10 个不依赖 Pi 进程或模型的回归测试，覆盖工具名、渲染链、组件复用、自有外框、无原始渲染器、展开和 read 分组。
- 注册 Pi 1.1.0 类型检查。
