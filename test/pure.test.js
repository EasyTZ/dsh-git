import test from "node:test";
import assert from "node:assert";
import {
  classifyGitError, gitErrorText, mergeCommitFiles,
  parseNameStatusZ, parseNumstatZ, parseStatusZ
} from "../lib/pure.js";

// 这些函数解析的是 git 的机器可读输出。解析错了**不会报错**，只会让面板安静地
// 少一个文件、多一行数字、或者把错误原因说成另一回事 —— 用例挑的就是这几类
// 「安静地错」的边界：文件名含空格、重命名占两个 token、二进制文件没有行数、
// 以及 git 把提示写去 stdout 而不是 stderr。

const NUL = "\0";
const z = (...parts) => parts.join(NUL) + NUL;

// ── parseStatusZ ────────────────────────────────────────────────────────────

test("parseStatusZ: 分支、ahead/behind 与三类改动", () => {
  const raw = z(
    "# branch.oid abc123",
    "# branch.head main",
    "# branch.ab +2 -3",
    "1 M. N... 100644 100644 100644 aaa bbb src/a.js",
    "1 .M N... 100644 100644 100644 aaa bbb src/b.js",
    "? untracked.txt",
  );
  const r = parseStatusZ(raw);
  assert.strictEqual(r.branch, "main");
  assert.strictEqual(r.detached, false);
  assert.strictEqual(r.unborn, false);
  assert.strictEqual(r.hasUpstream, true);
  assert.strictEqual(r.ahead, 2);
  assert.strictEqual(r.behind, 3);
  assert.deepStrictEqual(r.staged.map((e) => e.path), ["src/a.js"]);
  assert.deepStrictEqual(r.unstaged.map((e) => e.path), ["src/b.js"]);
  assert.deepStrictEqual(r.untracked.map((e) => e.path), ["untracked.txt"]);
});

test("parseStatusZ: 文件名含空格不能被截断", () => {
  // 按空格 split 是这里最容易犯的错，而带空格的文件名在 Windows 上极其常见
  // （"New Document.txt"）。截断的表现是面板里显示半个文件名，暂存时报路径不存在。
  const raw = z("1 M. N... 100644 100644 100644 aaa bbb docs/My Notes v2.md");
  const r = parseStatusZ(raw);
  assert.deepStrictEqual(r.staged.map((e) => e.path), ["docs/My Notes v2.md"]);
});

test("parseStatusZ: 重命名记录额外吃掉下一个 token 作为原路径", () => {
  // '2' 记录的原路径在**下一个** NUL 段里，必须被消费掉。
  //
  // 原路径故意取 "? old.txt"：如果这段没被消费，它会作为独立 token 进入主循环，
  // 首字符 '?' 命中未跟踪分支，凭空多出一个文件。用普通路径（"old/name.js"）写
  // 这条用例是测不出来的 —— 那种 token 不匹配任何前缀，会被静默跳过，改坏了
  // 也不会红。这是拿变异测试试出来的，别改回普通路径。
  const raw = z(
    "2 R. N... 100644 100644 100644 aaa bbb R100 new/name.js",
    "? old.txt",
    "? after.txt",
  );
  const r = parseStatusZ(raw);
  assert.strictEqual(r.staged.length, 1);
  assert.strictEqual(r.staged[0].path, "new/name.js");
  assert.strictEqual(r.staged[0].origPath, "? old.txt");
  assert.deepStrictEqual(r.untracked.map((e) => e.path), ["after.txt"], "原路径没被消费就会在这里多出一条");
});

test("parseStatusZ: 没有 branch.ab 行 = 没有上游分支", () => {
  // 第一次推一个新分支时就是这个状态，面板据此决定推送要不要带 --set-upstream。
  const r = parseStatusZ(z("# branch.head feature/x"));
  assert.strictEqual(r.hasUpstream, false);
  assert.strictEqual(r.ahead, 0);
  assert.strictEqual(r.behind, 0);
});

test("parseStatusZ: 空仓库与游离 HEAD", () => {
  assert.strictEqual(parseStatusZ(z("# branch.oid (initial)")).unborn, true);
  assert.strictEqual(parseStatusZ(z("# branch.head (detached)")).detached, true);
});

test("parseStatusZ: 空输入不抛异常", () => {
  const r = parseStatusZ("");
  assert.deepStrictEqual([r.staged, r.unstaged, r.untracked], [[], [], []]);
});

test("parseStatusZ: 同时暂存与未暂存的文件出现在两个清单里", () => {
  // xy = "MM"：暂存了一版、之后又改了。两个清单都要有，且必须是各自独立的对象
  // （共用一个对象时，面板给其中一侧打标记会串到另一侧）。
  const r = parseStatusZ(z("1 MM N... 100644 100644 100644 aaa bbb src/c.js"));
  assert.deepStrictEqual(r.staged.map((e) => e.path), ["src/c.js"]);
  assert.deepStrictEqual(r.unstaged.map((e) => e.path), ["src/c.js"]);
  assert.notStrictEqual(r.staged[0], r.unstaged[0], "两侧不能是同一个对象引用");
});

// ── parseNumstatZ / parseNameStatusZ / mergeCommitFiles ─────────────────────

test("parseNumstatZ: 普通改动", () => {
  assert.deepStrictEqual(parseNumstatZ(z("3\t1\tsrc/a.js")), [
    { path: "src/a.js", insertions: 3, deletions: 1 },
  ]);
});

test("parseNumstatZ: 二进制文件的增删是 null，不是 0", () => {
  // git 对二进制文件输出 `-`。当成 0 的话，面板会显示「+0 -0」，看起来像
  // 「改了个寂寞」，而实际上是「没有行数这个概念」。
  const r = parseNumstatZ(z("-\t-\tassets/logo.png"));
  assert.deepStrictEqual(r, [{ path: "assets/logo.png", insertions: null, deletions: null }]);
});

test("parseNumstatZ: 重命名的路径拆在后两段，取新路径", () => {
  // 重命名时这条记录形如 `<加>\t<删>\t\0<旧>\0<新>\0` —— 第三个字段是空的。
  const raw = "5\t2\t" + NUL + "old/a.js" + NUL + "new/a.js" + NUL;
  assert.deepStrictEqual(parseNumstatZ(raw), [
    { path: "new/a.js", insertions: 5, deletions: 2 },
  ]);
});

test("parseNameStatusZ: 普通状态取首字母，重命名带 from", () => {
  const raw = z("M", "src/a.js", "R100", "old/b.js", "new/b.js", "D", "gone.js");
  assert.deepStrictEqual(parseNameStatusZ(raw), [
    { status: "M", from: null, path: "src/a.js" },
    { status: "R", from: "old/b.js", path: "new/b.js" },
    { status: "D", from: null, path: "gone.js" },
  ]);
});

test("mergeCommitFiles: 按新路径对齐，二进制标记正确", () => {
  const merged = mergeCommitFiles(
    [
      { path: "src/a.js", insertions: 3, deletions: 1 },
      { path: "assets/logo.png", insertions: null, deletions: null },
    ],
    [
      { status: "M", from: null, path: "src/a.js" },
      { status: "A", from: null, path: "assets/logo.png" },
    ],
  );
  assert.deepStrictEqual(merged, [
    { path: "src/a.js", from: null, status: "M", insertions: 3, deletions: 1, binary: false },
    { path: "assets/logo.png", from: null, status: "A", insertions: null, deletions: null, binary: true },
  ]);
});

test("mergeCommitFiles: 只在 name-status 里出现的文件不能被丢掉", () => {
  // 空文件的新增在 numstat 里是 `0\t0`，但**模式变更**（chmod）之类只出现在
  // name-status 里。以 numstat 为主循环就会漏掉它们，表现是详情里少几个文件。
  const merged = mergeCommitFiles([], [{ status: "A", from: null, path: "empty.txt" }]);
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual(merged[0], {
    path: "empty.txt", from: null, status: "A",
    insertions: null, deletions: null, binary: false,
  });
});

// ── 错误分类 ────────────────────────────────────────────────────────────────

test("gitErrorText: stdout 与 stderr 都要看", () => {
  // 实测：`git commit` 在「没有暂存内容」时把人话提示写去 stdout，退出码仍非零。
  // 只查 stderr 会永远读到空字符串，于是所有失败都被归成通用 git-error。
  assert.match(gitErrorText({ stdout: "nothing to commit, working tree clean" }), /nothing to commit/);
  assert.match(gitErrorText({ stderr: "fatal: not a git repository" }), /not a git repository/);
  assert.doesNotThrow(() => gitErrorText(undefined));
});

test("classifyGitError: 各类失败归到各自的 code", () => {
  const code = (e) => classifyGitError(e).code;
  assert.strictEqual(code({ code: "ENOENT" }), "git-not-found");
  assert.strictEqual(code({ stderr: "fatal: not a git repository (or any of the parent directories)" }), "not-a-repo");
  assert.strictEqual(code({ stderr: "Unable to create '.git/index.lock': File exists." }), "index-locked");
  assert.strictEqual(code({ stdout: "nothing to commit, working tree clean" }), "nothing-to-commit");
  assert.strictEqual(code({ stderr: "Please tell me who you are" }), "no-identity");
  assert.strictEqual(code({ stderr: "fatal: No configured push destination." }), "no-remote");
  assert.strictEqual(code({ stderr: "! [rejected]        main -> main (fetch first)" }), "push-rejected");
});

test("classifyGitError: firstCommit 标记优先于文本分类", () => {
  // git 对「HEAD~1 不存在」说的是 "ambiguous argument 'HEAD~1': unknown revision"，
  // 其中 "unknown revision" 会命中 no-commits 那条正则 —— 但这里仓库明明有提交，
  // 只是没有更早的了。两码事，靠专门的标记优先分流。
  const e = { firstCommit: true, stderr: "fatal: ambiguous argument 'HEAD~1': unknown revision" };
  assert.strictEqual(classifyGitError(e).code, "first-commit");
});

test("classifyGitError: 本地改动会被覆盖时，保留完整文件列表", () => {
  // 这条错误的价值全在文件列表里，只截第一行等于把最有用的部分丢掉。
  const text = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.js\n\tsrc/b.js";
  const r = classifyGitError({ stderr: text });
  assert.strictEqual(r.code, "local-changes-blocked");
  assert.match(r.message, /src\/b\.js/, "文件列表必须保留");
});

test("classifyGitError: 认不出来的错误退回第一行，不能是空串", () => {
  const r = classifyGitError({ stderr: "fatal: 某种我们没见过的失败\n第二行" });
  assert.strictEqual(r.code, "git-error");
  assert.strictEqual(r.message, "fatal: 某种我们没见过的失败");
  assert.ok(classifyGitError({}).message.length > 0, "什么都没有时也要给一句话");
});

// ── 侧边栏 footer 布局 ──────────────────────────────────────────────────────

test("侧边栏 footer 的纵向排列由本插件自带，不靠别的插件的样式兜底", async () => {
  // 上游那个容器是 display:flex（默认 row、不换行），每个 footer action 都是
  // width:100% 的按钮 —— 装了两个以上就被挤成同行的半宽按钮，文字全被省略号吃掉。
  // 这条 flex-direction:column 原先只写在 dsh-terminal-panel 里，于是「装了终端
  // 面板的机器一切正常、只装市场 + 余额的机器上图标挤成一行」：一个插件的样式在
  // 替别的插件兜底，而任何一个插件都可能被单独安装。四个 footer 插件各带一份。
  //
  // 判据要跳过注释行、还原反斜杠转义：本文件说的这段话里也有这串选择器，只 grep
  // 源码的话，把规则删掉只留注释，测试照样绿。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const client = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
  const css = fs.readFileSync(client, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\\"/g, '"');
  assert.ok(
    /\[class\*="footerActions"\]\{[^}]*flex-direction:column/.test(css),
    "Git 插件必须自己注入 footerActions 的纵向排列规则"
  );
});
