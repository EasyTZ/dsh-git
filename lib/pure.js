// dsh-git 的纯解析逻辑：零 import、无副作用、不碰 ctx / req / res。
//
// 单独一个文件是为了**可单测**。这些函数解析的是 git 的机器可读输出（porcelain=v2、
// --numstat -z、--name-status -z），格式细节多、边界条件多（含空格的文件名、重命名
// 占两个 token、二进制文件的增删是 `-` 而不是 0），而它们又决定了面板里显示的每一
// 个文件与数字——解析错了不会报错，只会安静地少一个文件或多一行数字。
//
// 放在 index.js 里就没法测：那个文件顶部 import 了 @deepseek-ai/cordis 与 node
// 内置模块，测试进程拿不到 cordis。拆出来之后 `node --test` 直接 import 即可。
// 这与主仓库 dsh-plugin-manager 的 lib/pure.js 是同一套约定。

/**
 * git 的失败提示不一定在 stderr——实测 `git commit` 在「没有暂存内容」时
 * 把那段人话提示写去 stdout（退出码依然非零）。所有需要检查 git 输出内容
 * 的地方（分类失败原因、判断要不要自动重试）都用这个，别只查 stderr。
 * @param {{ stdout?: string, stderr?: string }} error
 */
export function gitErrorText(error) {
  return String(error?.stdout ?? "") + "\n" + String(error?.stderr ?? "");
}

export function classifyGitError(error) {
  if (error?.code === "ENOENT") {
    return { code: "git-not-found", message: "未检测到 git，请确认已安装并加入 PATH" };
  }
  if (error?.untrackedOnly) {
    return { code: "untracked-only", message: "只有未跟踪的新文件，没有已跟踪文件的改动——请先点文件旁的「+」暂存后再提交" };
  }
  if (error?.firstCommit) {
    // 这个要放在通用文本分类之前：git 对「HEAD~1 不存在」的实际提示是
    // "ambiguous argument 'HEAD~1': unknown revision..."，其中 "unknown
    // revision" 会命中下面 no-commits 那条正则，说成「仓库还没有任何提交」——
    // 但这里仓库明明有提交，只是没有更早的了，两码事，必须用专门的标记优先分流。
    return { code: "first-commit", message: "这是仓库的第一个提交，没有更早的状态可以退回" };
  }
  const text = gitErrorText(error);
  if (/not a git repository/i.test(text)) {
    return { code: "not-a-repo", message: "当前工作区不是 Git 仓库" };
  }
  if (/index\.lock/i.test(text)) {
    return { code: "index-locked", message: "Git 索引被占用（可能有其他 Git 操作正在进行），请稍后重试" };
  }
  if (/nothing to commit, working tree clean/i.test(text)) {
    // git 在「有改动但没暂存」时说的是 "no changes added to commit" /
    // "nothing added to commit but untracked files present"，都不含
    // "nothing to commit" 这个词组——那两种走的是 handleCommit 里的自动
    // 暂存重试，根本不会走到这条分类。真正落到这里的，是工作区彻底干净。
    return { code: "nothing-to-commit", message: "没有可提交的更改" };
  }
  if (/Please tell me who you are|user\.email|user\.name/i.test(text)) {
    return { code: "no-identity", message: "未配置 Git 用户名/邮箱（git config user.name / user.email）" };
  }
  if (/does not have any commits yet|unknown revision|ambiguous argument 'HEAD'|Failed to resolve 'HEAD'/i.test(text)) {
    return { code: "no-commits", message: "仓库还没有任何提交" };
  }
  if (/would be overwritten by (checkout|merge)/i.test(text)) {
    // "checkout" 是切分支时的措辞，"merge" 是 revert/合并类操作时的措辞——
    // 都是「工作区有未提交的改动，会被冲掉」这同一件事，用同一个 code。
    // 这条错误的价值在文件列表，只截第一行会把最有用的部分丢掉。
    return { code: "local-changes-blocked", message: text.trim() };
  }
  if (/No configured push destination/i.test(text)) {
    return { code: "no-remote", message: "未配置远程仓库（需要先 git remote add origin <url>）" };
  }
  if (/\[rejected\]|failed to push some refs/i.test(text)) {
    // pull 这次没做，拒绝之后没有别的路可退——只能明确告诉用户去终端处理，
    // 不能假装能在面板里一键解决。
    return { code: "push-rejected", message: "远端有本地没有的提交，需要先在终端执行 git pull 再推送" };
  }
  const firstLine = text.trim().split("\n")[0];
  return { code: "git-error", message: firstLine || error?.message || "Git 命令执行失败" };
}

/**
 * 解析 `git status --porcelain=v2 --untracked-files=all -z -b` 的输出。
 * -z 让所有记录以 NUL 结尾（而不是 LF），先按 NUL 切分成 token 再逐个识别类型：
 *   '#' 分支信息；'1' 普通变更；'2' 重命名/复制（额外占用下一个 token 作为原路径）；
 *   'u' 冲突；'?' 未跟踪。
 * 每种记录类型的字段数固定，用 anchored 正则整体匹配、把最后一段直接当路径——
 * 不能按空格 split，文件名本身可能含空格。
 * @param {string} raw
 */
export function parseStatusZ(raw) {
  const tokens = raw.length === 0 ? [] : raw.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

  let branch = null;
  let detached = false;
  let unborn = false;
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const unstaged = [];
  const untracked = [];

  const RE_ORDINARY = /^1 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;
  const RE_RENAME = /^2 (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;
  const RE_UNMERGED = /^u (\S\S) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/s;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const marker = token.charAt(0);

    if (marker === "#") {
      const rest = token.slice(2);
      if (rest.startsWith("branch.head ")) {
        branch = rest.slice("branch.head ".length);
        detached = branch === "(detached)";
      } else if (rest.startsWith("branch.oid ")) {
        unborn = rest.slice("branch.oid ".length) === "(initial)";
      } else if (rest.startsWith("branch.ab ")) {
        // git 只在配置了上游分支时才会输出这一行——没有它就说明没有 upstream，
        // 不需要单独解析 branch.upstream 那一行来判断有没有跟踪关系。
        hasUpstream = true;
        const m = /^\+(\d+) -(\d+)$/.exec(rest.slice("branch.ab ".length));
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      }
      i += 1;
      continue;
    }

    if (marker === "1" || marker === "2" || marker === "u") {
      const re = marker === "1" ? RE_ORDINARY : marker === "2" ? RE_RENAME : RE_UNMERGED;
      const m = re.exec(token);
      if (!m) {
        i += 1;
        continue;
      }
      const xy = m[1];
      const path = m[2];
      const x = xy.charAt(0);
      const y = xy.charAt(1);
      const entry = { path, x, y };
      if (marker === "2") {
        i += 1;
        entry.origPath = tokens[i];
      }
      if (x !== "." ) staged.push(entry);
      if (y !== "." && y !== "?") unstaged.push({ ...entry });
      i += 1;
      continue;
    }

    if (marker === "?") {
      untracked.push({ path: token.slice(2) });
      i += 1;
      continue;
    }

    // '!'（ignored，我们没请求）或未知前缀，跳过。
    i += 1;
  }

  return { branch, detached, unborn, hasUpstream, ahead, behind, staged, unstaged, untracked };
}

/**
 * 解析 `--numstat -z` 的输出。普通改动是 `<加>\t<删>\t<路径>\0`；重命名/复制是
 * `<加>\t<删>\t\0<旧路径>\0<新路径>\0`（前三段那个字段以 \t 结尾、路径为空）。
 * 二进制文件的增删两列是 `-`，用 null 表示「没有行数概念」，不要当 0。
 */
export function parseNumstatZ(raw) {
  const parts = String(raw ?? "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i];
    if (!chunk) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(chunk);
    if (!m) continue;
    const [, add, del, inlinePath] = m;
    let path = inlinePath;
    if (path === "") {
      // 重命名：接下来两段分别是旧路径与新路径，取新的。
      path = parts[i + 2] ?? parts[i + 1] ?? "";
      i += 2;
    }
    out.push({
      path,
      insertions: add === "-" ? null : Number(add),
      deletions: del === "-" ? null : Number(del)
    });
  }
  return out;
}

/**
 * 解析 `--name-status -z`：`<状态>\0<路径>\0`，重命名/复制是
 * `<状态><相似度>\0<旧路径>\0<新路径>\0`。状态只取首字母（R100 → R）。
 */
export function parseNameStatusZ(raw) {
  const parts = String(raw ?? "").split("\0").filter((p) => p.length > 0);
  const out = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    const letter = status.charAt(0);
    if (letter === "R" || letter === "C") {
      out.push({ status: letter, from: parts[i + 1] ?? "", path: parts[i + 2] ?? "" });
      i += 3;
    } else {
      out.push({ status: letter, from: null, path: parts[i + 1] ?? "" });
      i += 2;
    }
  }
  return out;
}

/** 按新路径把两份清单合起来；只在 name-status 里出现的也要保留（否则会漏文件）。 */
export function mergeCommitFiles(numstat, nameStatus) {
  const counts = new Map(numstat.map((n) => [n.path, n]));
  return nameStatus.map((entry) => {
    const n = counts.get(entry.path);
    return {
      path: entry.path,
      from: entry.from,
      status: entry.status,
      insertions: n ? n.insertions : null,
      deletions: n ? n.deletions : null,
      binary: n ? n.insertions === null && n.deletions === null : false
    };
  });
}
