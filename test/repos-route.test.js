// /api/dsdesktop/git/repos 这条路由的端到端冒烟测试：真的建临时目录、真的跑 git init、
// 真的调 handler。
//
// 为什么不满足于对 discoverRepos 的单测：这条路由的分支判断靠的是「git rev-parse
// --show-toplevel 在这里成不成功」，那是 git 的真实行为，不是我们能在单测里假设对的
// 东西——工作区根**在仓库里**就不该显示仓库下拉（哪怕它是仓库的子目录，git 自己会
// 向上找），只有根本不在任何仓库里时才扫子目录。这个判断错了，面板要么多一个没用的
// 下拉，要么在该给下拉的时候不给。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __test__ } from "../lib/index.js";

const { handleRepos } = __test__;

function gitInit(dir) {
  execFileSync("git", ["init", "--quiet"], { cwd: dir, windowsHide: true });
}

/** 收集 handler 写回的 JSON。 */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (raw) => { res.body = JSON.parse(raw); };
  return res;
}

function fakeReq(workspaceId) {
  return { method: "GET", url: `/api/dsdesktop/git/repos?workspaceId=${encodeURIComponent(workspaceId)}`, headers: {} };
}

function fakeCtx(path) {
  return { workspaceRegistry: { get: () => ({ path }) } };
}

async function call(rootPath) {
  const res = fakeRes();
  await handleRepos(fakeCtx(rootPath), fakeReq("ws1"), res);
  return res.body;
}

test("repos: 工作区根自己就是仓库 → 空列表（前端不显示仓库下拉）", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-route-"));
  try {
    gitInit(root);
    const body = await call(root);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.repos, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repos: 工作区根是仓库的子目录 → 也是空列表（git 自己会向上找）", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-route-"));
  try {
    gitInit(root);
    const nested = join(root, "packages", "web");
    await mkdir(nested, { recursive: true });
    const body = await call(nested);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.repos, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repos: 根不是仓库、子目录里有 N 个 → 列出它们并给一个 suggested", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-route-"));
  try {
    for (const name of ["app", "plugin"]) {
      await mkdir(join(root, name), { recursive: true });
      gitInit(join(root, name));
    }
    await mkdir(join(root, "notes"), { recursive: true });
    const body = await call(root);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.repos.map((r) => r.id), ["app", "plugin"]);
    assert.ok(["app", "plugin"].includes(body.data.suggested));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repos: 根不是仓库、子目录里也没有 → 空列表 + suggested 为 null", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-route-"));
  try {
    await mkdir(join(root, "notes"), { recursive: true });
    const body = await call(root);
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.repos, []);
    assert.equal(body.data.suggested, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repos: 工作区目录不存在 → workspace-missing", async () => {
  const body = await call(join(tmpdir(), "dsh-git-route-gone-xyz"));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "workspace-missing");
});
