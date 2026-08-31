// 子仓库发现与路径解析的单测。
//
// 为什么这份值得写：`resolveRepoPath` 是「浏览器半传来的字符串 → 会被 cd 进去执行
// git 的真实路径」这条链上唯一的关卡。它挡不住的东西，代价是任意目录跑 git（面板
// 里有 commit / push / checkout / undo-commit 这些写操作）。这类代码不能靠肉眼审——
// 第一版的 `/[\/]/` 就漏了反斜杠，在 Windows 上等于没设防，是这份测试逼出来的。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { __test__ } from "../lib/index.js";

const { discoverRepos, resolveRepoPath } = __test__;

/** 造一个临时工作区；返回根路径与清理函数。 */
async function makeTree() {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-test-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 假 ctx：只需要 workspaceRegistry.get 这一个方法。 */
function fakeCtx(path) {
  return { workspaceRegistry: { get: () => (path === null ? undefined : { path }) } };
}

async function makeRepo(root, name) {
  await mkdir(join(root, name), { recursive: true });
  await mkdir(join(root, name, ".git"), { recursive: true });
}

test("discoverRepos: 扫出一层里的子仓库，按名字排序", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await makeRepo(root, "zeta");
    await makeRepo(root, "alpha");
    await mkdir(join(root, "plain-dir"), { recursive: true });
    const repos = await discoverRepos(root);
    assert.deepEqual(repos.map((r) => r.id), ["alpha", "zeta"]);
  } finally {
    await cleanup();
  }
});

test("discoverRepos: node_modules 与点开头目录不算数", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await makeRepo(root, "node_modules");
    await makeRepo(root, ".cache");
    await makeRepo(root, "app");
    const repos = await discoverRepos(root);
    assert.deepEqual(repos.map((r) => r.id), ["app"]);
  } finally {
    await cleanup();
  }
});

test("discoverRepos: .git 是文件（worktree/submodule 的 gitdir 指针）也算仓库", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await mkdir(join(root, "wt"), { recursive: true });
    await writeFile(join(root, "wt", ".git"), "gitdir: ../.git/worktrees/wt\n");
    const repos = await discoverRepos(root);
    assert.deepEqual(repos.map((r) => r.id), ["wt"]);
  } finally {
    await cleanup();
  }
});

test("discoverRepos: 目录读不了时返回空数组，不抛", async () => {
  assert.deepEqual(await discoverRepos(join(tmpdir(), "dsh-git-does-not-exist-xyz")), []);
});

test("resolveRepoPath: 不带 repo 时就是工作区根", async () => {
  const { root, cleanup } = await makeTree();
  try {
    const resolved = await resolveRepoPath(fakeCtx(root), "ws1");
    assert.equal(resolved.path, root);
  } finally {
    await cleanup();
  }
});

test("resolveRepoPath: 带 repo 时落到子仓库", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await makeRepo(root, "app");
    const resolved = await resolveRepoPath(fakeCtx(root), "ws1", "app");
    assert.equal(resolved.path, join(root, "app"));
  } finally {
    await cleanup();
  }
});

test("resolveRepoPath: 子目录里没有 .git 时报 repo-not-found，不是 not-a-repo", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await mkdir(join(root, "plain"), { recursive: true });
    const resolved = await resolveRepoPath(fakeCtx(root), "ws1", "plain");
    assert.equal(resolved.error.code, "repo-not-found");
  } finally {
    await cleanup();
  }
});

test("resolveRepoPath: 工作区目录不存在时报 workspace-missing，而不是冒充 git 没装", async () => {
  const ctx = fakeCtx(join(tmpdir(), "dsh-git-gone-xyz"));
  const resolved = await resolveRepoPath(ctx, "ws1");
  assert.equal(resolved.error.code, "workspace-missing");
});

test("resolveRepoPath: 工作区不在注册表里", async () => {
  const resolved = await resolveRepoPath(fakeCtx(null), "ws1");
  assert.equal(resolved.error.code, "workspace-not-found");
});

test("resolveRepoPath: 任何带分隔符 / 盘符 / .. 的 repo 一律拒绝", async () => {
  const { root, cleanup } = await makeTree();
  try {
    const ctx = fakeCtx(root);
    const attacks = [
      "..",
      ".",
      "../sibling",
      "..\\sibling",
      "a/../..",
      "a\\..\\..",
      "sub/nested",
      "sub\\nested",
      "C:\\Windows",
      "C:",
      "/etc",
      "\\\\server\\share"
    ];
    for (const repo of attacks) {
      const resolved = await resolveRepoPath(ctx, "ws1", repo);
      assert.equal(resolved.error?.code, "bad-repo", `没挡住：${JSON.stringify(repo)}`);
      assert.equal(resolved.path, undefined, `漏出了路径：${JSON.stringify(repo)}`);
    }
  } finally {
    await cleanup();
  }
});

test("resolveRepoPath: repo 不是字符串也拒绝", async () => {
  const { root, cleanup } = await makeTree();
  try {
    for (const repo of [42, {}, [], true]) {
      const resolved = await resolveRepoPath(fakeCtx(root), "ws1", repo);
      assert.equal(resolved.error?.code, "bad-repo");
    }
  } finally {
    await cleanup();
  }
});

test("resolveRepoPath: workspaceId 缺失", async () => {
  assert.equal((await resolveRepoPath(fakeCtx("/tmp"), "")).error.code, "missing-workspace");
  assert.equal((await resolveRepoPath(fakeCtx("/tmp"), undefined)).error.code, "missing-workspace");
});

test("resolveRepoPath: 工作区路径用正斜杠写也要能解析（Windows 上 join 出的是反斜杠）", async () => {
  const { root, cleanup } = await makeTree();
  try {
    await makeRepo(root, "app");
    // 把根改写成正斜杠形式——Windows 上这么写完全合法、stat 也认，但 join 的输出
    // 是反斜杠。第一版的「兜底断言」直接拿两种写法 startsWith，把合法仓库拦成了越权。
    const forwardSlashRoot = root.split(sep).join("/");
    const resolved = await resolveRepoPath(fakeCtx(forwardSlashRoot), "ws1", "app");
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.path, join(root, "app"));
  } finally {
    await cleanup();
  }
});
