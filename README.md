# dsh-git

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在侧边栏提供一个 **Git 可视化面板**。

改动 / 未跟踪文件、暂存与取消暂存、写提交信息并提交、推送、切换分支、查看最近提交历史（区分已推送 / 未推送）、**点开任意一条提交看完整详情**（完整提交信息、改动了哪些文件、各自增删多少行）、撤销最近一次提交（未推送 reset、已推送 revert）——常用 Git 操作点几下就完事，不用离开 dsh 也不用记命令。

## 前置要求

- dsh `>= 0.1.1-rc.2`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-host-webserver ^0.1.1-rc.2`、`@deepseek-ai/dsh-workspace ^0.1.1-rc.2`）
- 机器上装了 `git` 且在 `PATH` 里
- `pnpm` 可用（`dsh plugin` 底层转发给 pnpm）

## 安装

一条命令装完：

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-git#v0.5.1
```

`<name>` 换成你的 profile 名（桌面版通常为 `web`，TUI 为 `tui`）。插件自带 `dsh.bundle` 层（`cordis.patch.yml`），`dsh plugin add` 会同时完成「装进去」和「注册激活」，**不需要再手写 patch**。

> 命令里的 `#v0.5.1` 是版本 tag，钉 tag 才能复现；想追最新可以改成 `#main`，但不建议。`dsh plugin` 底层转发给 pnpm，所以机器上要有可用的 `pnpm`。

重启 dsh 后，侧边栏底部会出现 Git 按钮。

## 使用

点侧边栏底部的 Git 按钮打开面板，常用操作都在面板里完成：查看改动 / 未跟踪文件、暂存 / 取消暂存、写提交信息并提交、推送、切换分支、查看最近提交历史（区分已推送 / 未推送）、点开任意提交看详情、撤销最近一次提交。

## 卸载

一条命令卸载：

```sh
dsh plugin --profile <name> remove @easytz/dsh-git
```

`<name>` 与安装时一致。`remove` 会把包从 profile 依赖里移除，`dsh` 随后会把它从激活清单（`dsh.profile.bundles`）里撤掉。

> 如果你按旧版 README 手动往 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml` 里加过 `- insert:` 条目，卸载时把那段 YAML 一起删掉。

重启 dsh 后，侧边栏里的 Git 按钮消失。

## 一个工作区装了多个仓库？

工作区根目录自己不是仓库、但下面的子目录各自是独立仓库（比如一个 `projects/` 下并排放着好几个 repo）时，面板会**往下扫一层**，把找到的仓库列在一个「仓库」下拉里，选中哪个就操作哪个。选择按工作区记住，下次打开还停在上次那个。

- 工作区根自己在某个仓库里（是仓库根，或者是仓库的子目录）时不显示这个下拉，行为跟单仓库完全一样。
- 只扫一层，且跳过 `node_modules`、`dist`、`build` 与点开头的目录 —— 否则 vendored 依赖里自带的 `.git` 会把列表淹掉。
- 默认停在 `.git` 最近被动过的那个仓库。

## 已知限制

- 撤销提交只支持最新一条（未推送走 `reset --mixed` 保留改动，已推送走 `revert` 生成反向提交）。
- 推送被远端拒绝（需要先 pull）时面板不代劳，会提示去终端执行 `git pull`。
- 未跟踪的新文件不会被「提交」按钮自动暂存——必须逐个点「+」明确选择，这是刻意设计。

## 平台支持

目前只在 Windows 上验证过；插件代码本身没有平台分支，理论上 macOS / Linux 也能跑，欢迎反馈。
