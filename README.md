# dsh-git

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）的第三方插件：在侧边栏提供一个 **Git 可视化面板**。

改动 / 未跟踪文件、暂存与取消暂存、写提交信息并提交、推送、切换分支、查看最近提交历史（区分已推送 / 未推送）、**点开任意一条提交看完整详情**（完整提交信息、改动了哪些文件、各自增删多少行）、撤销最近一次提交（未推送 reset、已推送 revert）——常用 Git 操作点几下就完事，不用离开 dsh 也不用记命令。

## 前置要求

- dsh `>= 0.1.1-rc.2`（peer 依赖：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-host-webserver ^0.1.1-rc.2`、`@deepseek-ai/dsh-workspace ^0.1.1-rc.2`）
- 机器上装了 `git` 且在 `PATH` 里

## 安装

「装进去」和「打开它」是两件事，缺一不可：

```sh
dsh plugin --profile <name> add github:EasyTZ/dsh-git#v0.2.2
```

> **必须写 GitHub 地址，不能只写包名。** `dsh plugin add` 会把参数原样转给 pnpm，只写 `dsh-git` 会去 npm registry 找同名包 —— 那可能是别人的包（`dsh-git` 在 npm 上就已被他人占用）。换个 tag 就是换版本；想跟最新可以用 `#main`，但**不建议**：钉 tag 才能复现。

## 激活

往 patch 层文件（`$DSH_HOME/profiles/<name>/cordis.patch.yml` 或机器级 `$DSH_HOME/cordis.patch.yml`）里加一条 `- insert:` 条目：

```yaml
- insert:
    - id: dsh-git
      name: 'dsh-git'
```

> **`id` 别用通用词**（比如 `git`）。`- insert:` 不去重：一旦与 dsh 自带 bundle 里某条条目同名，cordis loader 会抛 `duplicate loader entry id`，**内核直接退出**。dsh 自带的 id 里有大量 `git` / `session` / `settings` / `storage` 这类通用词，而且内核会自行更新到新版本 —— 撞车只是时间问题。直接拿包名当 id 最省事。

重启 dsh 后，侧边栏底部会出现 Git 按钮，点它打开面板。

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
