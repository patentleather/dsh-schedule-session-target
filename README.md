# dsh-schedule-session-target

给 DSH 官方 `@deepseek-ai/dsh-schedule` 的定时任务选择**到点时在哪个会话执行**。

| 选项 | 行为 |
|---|---|
| **关联会话**（官方默认） | 投递回任务绑定的原会话 —— 官方既有行为 |
| **新会话** | 每次触发都新建一个会话执行，不继承上下文，标题写成 `[定时] <任务名>` |

切换入口：打开「自动化任务」看板，页面底部会出现「执行会话」悬浮控制条，可逐任务切换。

控制条里每条任务还有一个 **立即执行** 按钮：不等定时、按该任务自己的设置立刻跑一次。
它**不改动定时计划** —— 不推进下次目标、不改任务状态、不写官方运行记录；带二次确认，避免误点。

## 原理

官方把投递目标写死为任务绑定的原会话，也没有对外扩展点。本插件不修改官方任何文件，只在运行时包一层方法：

```
官方 ScheduleRuntime.drive()
  → ctx.sessionController.resolveAgent(task.sessionId)   ← 只包这一层
  → followup() → sessions.flush() → 写回执 / 推进下次目标
```

当（且仅当）某会话存在「新会话」模式、且任务此刻到点时，改为新建会话并把它的 agent交回官方运行时 —— 于是官方的 flush、回执、下次目标推进、看板、运行记录全部照常生效。
目标设置持久化在 `%DSH_HOME%\storages\schedule_session_target.json`。

## 安装

本包是标准的 DSH **组合包**（`dsh.bundle`），用 `dsh plugin` 装进 profile 即可 —— 不需要手动拷文件，也不需要手改 profile 的 `cordis.patch.yml`：

```sh
dsh plugin --profile web add github:patentleather/dsh-schedule-session-target   # 从 GitHub 安装
dsh plugin --profile web add ./schedule-session-target                          # 或本地 checkout
```

`dsh` 会把本包追加进该 profile 的 `dsh.profile.bundles`，并应用它自带的 `cordis.patch.yml`。

**更方便的安装方式**：在官方的“插件”选项卡（新会话下方）中点击“添加插件”，填入**“github:patentleather/dsh-schedule-session-target”**即可安装。
（本包没有发布到 npm，所以这里必须给 **git 地址**；只写包名会被当成注册表包名去查 npm，报 `404 Not Found`。）



**卸载**（依赖与配置层一起移除）：

```powershell
dsh plugin --profile web remove dsh-schedule-session-target
```

- 本包是纯 JavaScript、**没有构建步骤**，所以从 GitHub 安装**不需要** `allowBuilds` 授权
  （只有带 `prepare`/构建脚本的 TS 包才需要，见官方[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）。
- `add ./本地目录` 是 link 安装，改完源码直接生效（宿主半区的改动需重启 DSH）。
- profile 不是 `web` 就换成实际名字（比如桌面端，但更推荐去官方的“插件”选项中下载）；你自己 profile 的 `cordis.patch.yml` 在本包之后应用，
  想覆盖本包的配置不必改本包。

## 边界

- **同批合并：**同一会话创建的同一时间任务，会在同一会话中
- **新会话不带原会话上下文**
- **关掉插件即回到官方行为**
- **依赖未公开接缝** `sessionController.resolveAgent`

## 测试

```powershell
node test\smoke.mjs          # 宿主主路径：重定向、去重、落盘、路由
node test\client-smoke.mjs   # 浏览器半区（自带迷你 React 与最小 DOM 环境）
node test\robustness.mjs     # 卸载还原、官方分批语义、标题声称
node test\edge-cases.mjs     # 错误与兜底：新建失败退回、接管失败降级、参数校验
node test\manual-run.mjs     # 立即执行：两种落点、不改计划、防重复点击、失败上报
```



MIT

