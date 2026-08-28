import { execFile } from "node:child_process";
// 纯解析逻辑拆在 pure.js：零 import、可被 `node --test` 直接 import（本文件顶部
// 的 cordis 依赖让它自己没法进测试进程）。见 pure.js 头部说明。
import {
  classifyGitError, gitErrorText, mergeCommitFiles,
  parseNameStatusZ, parseNumstatZ, parseStatusZ
} from "./pure.js";

/**
 * Git 可视化面板（host 半）。
 * 注册 10 条 /api/dsdesktop/git/* 路由，浏览器半 fetch 它们。走 webServer 路由而非
 * Typert Remote，理由同余额插件：避免依赖编译生成的 remote descriptor（本项目无编译步骤）。
 *
 * 用**函数形式**的插件而不是 `Service` 子类：本插件不向任何人提供能力，占一个
 * cordis 服务名只有坏处 —— `ctx.provide` 撞名是直接抛异常的（cordis:
 * `service "git" has been registered at <...>`），等于在 boot 阶段杀掉内核、
 * 桌面端黑屏。而 `git` 恰好落在上游服务名的词表正中间（`fs`/`shell`/`web`/
 * `storage`/`sessions`/`terminals`…），内核还会自己热更新 —— 撞上只是时间问题。
 * 和 loader 的 `duplicate loader entry id` 是同一类事故，只是命名空间不同。
 *
 * 同理路由统一挂在 `/api/dsdesktop/` 前缀下：webServer 的 `register` 对重复
 * (kind, path) 也是直接抛，`/api/git/status` 这种通用路径不该由我们占着。
 *
 * 安全边界：浏览器半只传 workspaceId，这里用 ctx.workspaceRegistry 把它解析成
 * 真实路径——绝不能让浏览器半直接传路径，否则等于开放任意目录执行 git 的能力。
 */

const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 50;
// git log 的自定义 --pretty=format 用单元/记录分隔符（\x1f / \x1e），而不是逗号
// 或竖线之类的可见字符——commit subject 里出现这些字符完全合法，用不可见的
// ASCII 分隔符才不会跟真实内容混淆。
const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

/** 同一个仓库路径的 git 调用排成一条队列，避免我们自己并发调用互相踩 index.lock。 */
const repoLocks = new Map();

function runGit(repoPath, args) {
  const prev = repoLocks.get(repoPath) ?? Promise.resolve();
  const next = prev.then(() => execGit(repoPath, args), () => execGit(repoPath, args));
  // 不管这次成功还是失败都要把链条延续下去，否则一次失败会让后续调用永远排不上队。
  repoLocks.set(repoPath, next.catch(() => {}));
  return next;
}

function execGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: repoPath,
      // GIT_TERMINAL_PROMPT=0：git 在非 tty 环境下遇到需要凭据的操作会阻塞等待
      // 输入，把内核进程整个挂死。这条必须每次都带上。
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        // 分类逻辑不能只看 stderr——实测 `git commit` 在「没有暂存内容」时把
        // 那段人话提示写去 stdout（退出码依然非零），只查 stderr 会永远读到
        // 空字符串。stdout 也一并挂到 error 上，classifyGitError 两个都查。
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve(stdout);
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/** 校验 POST 的 Content-Type：不是 application/json 就 415（防无 preflight 的简单请求）。 */
function requireJson(req) {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  return ct.startsWith("application/json");
}

/**
 * Origin 校验：存在且不等于本服务自身 origin（同端口的 http://127.0.0.1 /
 * http://localhost）就拒绝。本服务从不发 Access-Control-Allow-Origin，所以跨源
 * 页面拿不到响应体 —— 但「拿不到响应」不等于「发不出请求」，恶意页面还是可以用
 * text/plain 发简单请求打本机回环端口，这条防线配合 Content-Type 检查一起关掉它。
 *
 * 这件事在本插件里格外重要：/api/git/ 下有 commit / push / checkout /
 * undo-commit 这些**会改动用户仓库**的写操作，一次得手就是往用户的远端推东西、
 * 或者把未提交的改动 reset 掉。端口是随机的，攻击者得先扫到它——但「要多花点
 * 力气」不是防线。
 */
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  return url.host === `127.0.0.1:${port}` || url.host === `localhost:${port}`;
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function resolveRepoPath(ctx, workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return { error: { code: "missing-workspace", message: "缺少 workspaceId" } };
  }
  const workspace = ctx.workspaceRegistry.get(workspaceId);
  if (!workspace) {
    return { error: { code: "workspace-not-found", message: "工作区不存在" } };
  }
  return { path: workspace.path };
}

async function handleStatus(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    const raw = await runGit(resolved.path, ["status", "--porcelain=v2", "--untracked-files=all", "-z", "-b"]);
    return sendJson(res, 200, { ok: true, data: parseStatusZ(raw) });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleLog(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
  try {
    const raw = await runGit(resolved.path, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ad${LOG_FIELD_SEP}%s${LOG_RECORD_SEP}`,
      "--date=iso-strict"
    ]);
    const commits = raw.length === 0 ? [] : raw.split(LOG_RECORD_SEP)
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .map((record) => {
        const [hash, shortHash, author, date, subject] = record.split(LOG_FIELD_SEP);
        return { hash, shortHash, author, date, subject };
      });
    return sendJson(res, 200, { ok: true, data: { commits } });
  } catch (error) {
    const classified = classifyGitError(error);
    // 空仓库（还没有第一个提交）不是错误，是正常状态，交给面板显示「尚无提交」。
    if (classified.code === "no-commits") return sendJson(res, 200, { ok: true, data: { commits: [] } });
    return sendJson(res, 200, { ok: false, error: classified });
  }
}

/**
 * 提交详情：完整提交信息（不只第一行）+ 改动文件与增删行数。
 *
 * 两次 git 调用，而不是想办法用一条命令拿全：
 *   1) `show -s` 取元信息与完整 message（%s 是标题、%b 是正文，正文可能多段）；
 *   2) `show --numstat --name-status` 取文件清单。
 * numstat 给增删行数、name-status 给状态字母（A/M/D/R…），两者各缺一半，合并
 * 之后才是「这次改了哪些文件、各改了多少」。合并按**新路径**对齐——重命名时
 * numstat 的 -z 输出会把旧路径与新路径拆成两个字段，取后者。
 */
async function handleCommitDetail(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });

  // hash 会被当作 git 的参数，必须先校验形状再传下去：只放行十六进制。这既挡住
  // 了以 `-` 开头被当成选项的输入，也挡住了 `HEAD~1`、`master` 这类我们没打算
  // 支持的 revision 写法——面板只会拿列表里的 hash 来问。
  const hash = String(url.searchParams.get("hash") ?? "");
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) {
    return sendJson(res, 200, fail("bad-hash", "提交 hash 不合法"));
  }

  try {
    const meta = await runGit(resolved.path, [
      "show", "-s", "--no-color", "--date=iso-strict",
      `--format=%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%ad${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%b`,
      hash, "--"
    ]);
    const [fullHash, shortHash, author, email, date, subject, body] = meta.split(LOG_FIELD_SEP);

    const [numstatRaw, nameStatusRaw] = await Promise.all([
      runGit(resolved.path, ["show", "--numstat", "--no-color", "--format=", "-z", hash, "--"]),
      runGit(resolved.path, ["show", "--name-status", "--no-color", "--format=", "-z", hash, "--"])
    ]);

    const files = mergeCommitFiles(parseNumstatZ(numstatRaw), parseNameStatusZ(nameStatusRaw));
    const totals = files.reduce((acc, f) => ({
      files: acc.files + 1,
      insertions: acc.insertions + (f.insertions ?? 0),
      deletions: acc.deletions + (f.deletions ?? 0)
    }), { files: 0, insertions: 0, deletions: 0 });

    return sendJson(res, 200, { ok: true, data: {
      hash: fullHash, shortHash, author, email, date,
      subject, body: (body ?? "").trim(),
      files, totals
    } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

function extractPaths(body) {
  return Array.isArray(body?.paths) ? body.paths.filter((p) => typeof p === "string" && p.length > 0) : [];
}

async function handleStage(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const paths = extractPaths(body);
  if (paths.length === 0) return sendJson(res, 200, fail("bad-request", "paths 不能为空"));
  try {
    await runGit(resolved.path, ["add", "--", ...paths]);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleUnstage(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const paths = extractPaths(body);
  if (paths.length === 0) return sendJson(res, 200, fail("bad-request", "paths 不能为空"));
  try {
    try {
      await runGit(resolved.path, ["reset", "--", ...paths]);
    } catch (error) {
      // 仓库还没有第一个提交时没有 HEAD 可解引用，`git reset` 会失败；
      // 退化成 `git rm --cached`，效果等价于把文件移出暂存区。
      if (/ambiguous argument 'HEAD'|unknown revision|Failed to resolve 'HEAD'/i.test(gitErrorText(error))) {
        await runGit(resolved.path, ["rm", "--cached", "--", ...paths]);
      } else {
        throw error;
      }
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleCommit(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length === 0) return sendJson(res, 200, fail("bad-request", "提交信息不能为空"));
  try {
    try {
      await runGit(resolved.path, ["commit", "-m", message]);
    } catch (error) {
      // 前端不强制用户先手动暂存已跟踪文件的改动——按钮点下去就该是「暂存
      // 全部已跟踪改动 + 提交」。但**未跟踪的新文件绝不自动暂存**：那是用户
      // 还没决定要不要纳入版本控制的东西，必须手动点「+」明确选择，不能靠
      // 提交按钮顺手带走——否则「+ 暂存又 − 取消暂存」这个操作会被下一次
      // 提交悄悄撤销，表现成「− 好像没生效」（这是真实踩过的一个体验问题，
      // 根源不在 −，在这里自动暂存的范围太宽）。
      //
      // 所以只在「有已跟踪文件的改动、只是没暂存」这一种 git 措辞时才自动
      // 暂存重试，且用 `add -u`（只更新已跟踪文件）不用 `add -A`（无差别
      // 全部暂存）。已经手动暂存过部分文件时第一次 commit 直接成功，不会
      // 走到这里；只有未跟踪文件、没有任何已跟踪改动时不重试，直接报错让
      // 用户自己去点 +；工作区真的干净时走 classifyGitError 的
      // nothing-to-commit 分支。这几句提示 git 写在 stdout，必须用
      // gitErrorText 而不是只查 error.stderr——之前只查 stderr 时这个
      // 分支永远进不去，端到端测试里直接暴露了这个坑。
      const text = gitErrorText(error);
      if (/no changes added to commit/i.test(text)) {
        await runGit(resolved.path, ["add", "-u"]);
        await runGit(resolved.path, ["commit", "-m", message]);
      } else if (/nothing added to commit but untracked files present/i.test(text)) {
        throw Object.assign(new Error("untracked-only"), { stderr: "", stdout: "", untrackedOnly: true });
      } else {
        throw error;
      }
    }
    let shortHash = null;
    try {
      shortHash = (await runGit(resolved.path, ["rev-parse", "--short", "HEAD"])).trim();
    } catch {
      // 提交本身已经成功，取哈希失败不影响提交结果，静默忽略。
    }
    return sendJson(res, 200, { ok: true, data: { shortHash } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleBranches(ctx, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, fail("method-not-allowed", "GET only"));
  const url = new URL(req.url, "http://localhost");
  const resolved = resolveRepoPath(ctx, url.searchParams.get("workspaceId"));
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    // refname:short + HEAD 用 tab 分隔——分支名不允许含空白字符，不需要 -z/NUL
    // 那一套（跟文件路径不一样，这里按行/按 tab split 是安全的）。
    const raw = await runGit(resolved.path, ["for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads/"]);
    const branches = raw.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, head] = line.split("\t");
        return { name, current: head === "*" };
      });
    return sendJson(res, 200, { ok: true, data: { branches } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleCheckout(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (branch.length === 0) return sendJson(res, 200, fail("bad-request", "branch 不能为空"));
  try {
    await runGit(resolved.path, ["checkout", branch]);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handlePush(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    try {
      await runGit(resolved.path, ["push"]);
    } catch (error) {
      // 没配置上游分支（第一次推这个分支）：取当前分支名，推到 origin 并建立
      // 跟踪关系，跟 GitHub Desktop / VS Code 的默认行为一致。远程本身不存在
      // 时会走另一条 "No configured push destination" 分支，那种没法自动
      // 修复，原样抛出去交给 classifyGitError。
      if (/has no upstream branch/i.test(gitErrorText(error))) {
        const branch = (await runGit(resolved.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        await runGit(resolved.path, ["push", "--set-upstream", "origin", branch]);
      } else {
        throw error;
      }
    }
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

async function handleUndoCommit(ctx, req, res) {
  if (req.method !== "POST") return sendJson(res, 405, fail("method-not-allowed", "POST only"));
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 200, fail("bad-request", "请求体不是合法 JSON"));
  }
  const resolved = resolveRepoPath(ctx, body.workspaceId);
  if (resolved.error) return sendJson(res, 200, { ok: false, error: resolved.error });
  try {
    // 自己重新查一遍有没有推送过，不信任浏览器半传来的状态——面板打开的这段
    // 时间里仓库状态可能已经变了（比如用户在终端里手动 push 过），撤销的方式
    // 选错了后果不轻（该 revert 的走了 reset，或者反过来）。
    const raw = await runGit(resolved.path, ["status", "--porcelain=v2", "-z", "-b"]);
    const { hasUpstream, ahead } = parseStatusZ(raw);
    const pushed = hasUpstream && ahead === 0;
    if (pushed) {
      // 已经推送过：只能 revert——生成一条新提交去抵消，不改写共享历史、
      // 不需要强推，不会让已经拉取过这次提交的协作者出问题。
      await runGit(resolved.path, ["revert", "--no-edit", "HEAD"]);
      return sendJson(res, 200, { ok: true, data: { mode: "revert" } });
    }
    // 还没推送：直接把这次提交从历史上摘掉，用 --mixed 保留改动到工作区
    // （不是 --hard 直接丢弃）——「撤销」不等于「删除我的代码」。
    try {
      await runGit(resolved.path, ["reset", "--mixed", "HEAD~1"]);
    } catch (error) {
      if (/unknown revision|ambiguous argument/i.test(gitErrorText(error))) {
        throw Object.assign(new Error("first-commit"), { firstCommit: true });
      }
      throw error;
    }
    return sendJson(res, 200, { ok: true, data: { mode: "reset" } });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: classifyGitError(error) });
  }
}

/** 所有桌面端插件的路由都挤在这个我们自己说了算的前缀下，见文件头注释。 */
const ROUTE_PREFIX = "/api/dsdesktop/git";

const ROUTES = [
  ["/status", handleStatus],
  ["/log", handleLog],
  ["/commit-detail", handleCommitDetail],
  ["/branches", handleBranches],
  ["/checkout", handleCheckout],
  ["/stage", handleStage],
  ["/unstage", handleUnstage],
  ["/commit", handleCommit],
  ["/push", handlePush],
  ["/undo-commit", handleUndoCommit]
];

/**
 * 所有路由的统一入口防线。放在这里而不是各个 handler 里：这套检查的价值来自
 * 「一条都不漏」，撒进十个 handler 就会有第十一个忘记加。
 */
function guard(ctx, req, res, handler) {
  // port 在请求时动态取：webServer 是 [Service.init] 时才绑定端口，
  // apply 执行时读到的还是 null。
  const port = ctx.webServer.port;
  if (port != null && !originAllowed(req, port)) {
    return sendJson(res, 403, fail("forbidden-origin", "跨源请求被拒绝"));
  }
  if (req.method === "POST" && !requireJson(req)) {
    return sendJson(res, 415, fail("unsupported-media-type", "Content-Type 必须是 application/json"));
  }
  return handler(ctx, req, res);
}

export const name = "dsh-git";

export const inject = ["webServer", "workspaceRegistry"];

export function apply(ctx) {
  for (const [suffix, handler] of ROUTES) {
    const path = `${ROUTE_PREFIX}${suffix}`;
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path,
      handler: (req, res) => guard(ctx, req, res, handler)
    }), `git: ${path}`);
  }
}
