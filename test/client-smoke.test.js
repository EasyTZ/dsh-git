// 客户端半冒烟测试：在 node 里伪造浏览器全局与 React，真实执行 lib/client.js。
// 为什么值得写：client.js 不在 typecheck 覆盖内，`node --check` 又只查语法——
// useCallback/useEffect 依赖数组在 render 时立即求值，引用后声明的 const 会触发
// TDZ、组件整个渲染崩溃，表现就是「面板打不开」。只有真实执行组件函数才暴露。
//
// 这份测试额外钉住**快照形状兼容**这条线：dsh 0.1.x 的 sessions.list 带 current、
// workspaces.list 带 recentWorkspaceId，0.2.x 把这两个字段都拿掉了（会话选择移到
// 渲染器的 session 作用域）。同一份 client.js 两条线都要能走，改坏任何一边都会
// 在这里报红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
// fake-react.cjs 是 CommonJS（从 app 仓库原样搬来的共享件，本仓库 type: module
// 所以用 .cjs 后缀），default import 拿整个 module.exports 再解构。
import fakeReact from "./helpers/fake-react.cjs";

const { createFakeReact } = fakeReact;

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

/** 把元素树拍平成数组，便于查找。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  const children = node.props && node.props.children;
  if (children !== undefined) flatten(children, out);
  return out;
}

/** 本地记忆用的可控 localStorage：普通 Map 语义，还能断言写入了什么。 */
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

/** dsh 的 store 方法会读 `this`：按同一契约造假对象，getSnapshot/subscribe 不拆裸函数。 */
function mkStore(val) {
  return {
    value: val,
    getSnapshot() { return this.value; },
    subscribe() { return () => {}; },
  };
}

function loadModule(localStorageImpl) {
  const src = readFileSync(CLIENT, "utf8");
  const registrations = [];
  const styleTag = { dataset: {}, textContent: "" };
  Object.assign(globalThis, {
    window: {
      __ModuleLoader__: { load(reg) { registrations.push(reg); } },
      getSelection: () => ({ toString: () => "" }),
    },
    document: {
      querySelector: () => null,
      createElement: () => styleTag,
      head: { appendChild() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: localStorageImpl,
    // 按端点给「干净仓库」的完整响应形状：仓库发现、状态、日志、分支各归各，
    // 面板在渲染路径上会直接读这些字段（.length / .map），缺了会真崩——
    // 这正是冒烟测试要抓的那类错误。
    fetch: async (url) => {
      const path = String(url).split("?")[0];
      const data = path.endsWith("/repos") ? { repos: [] }
        : path.endsWith("/status") ? {
            staged: [], unstaged: [], untracked: [],
            branch: "main", ahead: 0, behind: 0,
            hasUpstream: true, detached: false, unborn: false,
          }
        : path.endsWith("/log") ? { commits: [] }
        : path.endsWith("/branches") ? { branches: [] }
        : { };
      return { ok: true, json: async () => ({ ok: true, data }) };
    },
  });
  const { jsxRuntime: reactJsx, hooks: reactHooks, render } = createFakeReact();
  const reactDom = { createPortal: (node) => node };
  const fakeRequire = (id) => {
    if (id === "react/jsx-runtime") return reactJsx;
    if (id === "react") return reactHooks;
    if (id === "react-dom") return reactDom;
    throw new Error("unexpected require: " + id);
  };
  // eslint-disable-next-line no-eval
  eval(src);
  assert.equal(registrations.length, 1, "应恰好注册一次");
  return { module: registrations[0].factory(fakeRequire), render };
}

const cleanup = () => Object.assign(globalThis, {
  window: undefined, document: undefined, localStorage: undefined, fetch: undefined,
});

const WORKS = [
  { workspaceId: "w1", path: "D:/a", title: "项目A", sessionIds: ["s1"] },
  { workspaceId: "w2", path: "D:/b", title: "项目B", sessionIds: ["s2"] },
];

/** 装载插件、注册槽位，再把面板组件真实渲染到稳定态。 */
async function renderPanel({ workspaces, sessions, localStorageImpl }) {
  const { module, render } = loadModule(localStorageImpl);
  assert.deepEqual(module.inject, ["slots", "locale", "workspaces", "sessions"]);
  const captured = {};
  const ctx = {
    effect: () => () => {},
    locale: { register() {} },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { captured[opts.name + ":" + opts.id] = comp; return () => {}; },
    },
    workspaces: { list: mkStore(workspaces) },
    sessions: { list: mkStore(sessions) },
  };
  module.apply(ctx);
  const panel = captured["shell.overlay:git-panel"];
  assert.ok(panel, "面板应注册进 shell.overlay");
  const store = { getSnapshot: () => true, subscribe: () => () => {}, close() {}, toggle() {} };
  const props = () => ({
    t: (k) => k,
    store,
    workspacesList: ctx.workspaces.list,
    sessionsList: ctx.sessions.list,
  });
  const tree = await render(() => panel(props()));
  // render / panel / props 一并交给测试：交互（打开下拉、点选项）需要再画几轮。
  return { module, ctx, render, panel, props, tree };
}

/** 工作区下拉当前显示的值（.dsgDropdownValue 的文本）。 */
function workspaceValue(tree) {
  const value = flatten(tree).find((n) => n.props && n.props.className === "dsgDropdownValue");
  return value ? String(value.props.children) : null;
}

function withCleanup(fn) {
  return async () => {
    try { await fn(); } finally { cleanup(); }
  };
}

test("0.1.x 快照：current 存在时选中当前会话所属工作区（优先于 recentWorkspaceId）", withCleanup(async () => {
  const { tree } = await renderPanel({
    workspaces: { items: WORKS, recentWorkspaceId: "w2" },
    sessions: { current: "s1" },
    localStorageImpl: makeLocalStorage(),
  });
  assert.equal(workspaceValue(tree), "项目A", "当前会话在 s1（项目A），应停到项目A");
}));

test("0.1.x 快照：没有打开的会话时退回 recentWorkspaceId", withCleanup(async () => {
  const { tree } = await renderPanel({
    workspaces: { items: WORKS, recentWorkspaceId: "w2" },
    sessions: { current: undefined },
    localStorageImpl: makeLocalStorage(),
  });
  assert.equal(workspaceValue(tree), "项目B", "无会话时应停在 recentWorkspaceId 指向的工作区");
}));

test("0.2.x 快照：current / recentWorkspaceId 都缺失时退回注册表第一项", withCleanup(async () => {
  const { tree } = await renderPanel({
    workspaces: { items: WORKS },
    sessions: { },
    localStorageImpl: makeLocalStorage(),
  });
  assert.equal(workspaceValue(tree), "项目A", "没有会话信息与记忆时默认第一项");
}));

test("0.2.x 快照：本地记忆的上次工作区优先生效，且换工作区会写入记忆", withCleanup(async () => {
  const ls = makeLocalStorage();
  ls.setItem("dsg:lastWorkspace", "w2");
  const { render, panel, props } = await renderPanel({
    workspaces: { items: WORKS },
    sessions: { },
    localStorageImpl: ls,
  });
  const tree = await render(() => panel(props()));
  assert.equal(workspaceValue(tree), "项目B", "记忆里是 w2，应停在项目B");

  // 用户手动把下拉切到项目A：先点开触发器，再点选项。
  const trigger = flatten(tree).find((n) => n.props && n.props.className === "dsgDropdownTrigger");
  trigger.props.onClick();
  const opened = await render(() => panel(props()));
  const option = flatten(opened).find((n) =>
    n.props && n.props.role === "option" && String(JSON.stringify(n.props.children)).includes("项目A"));
  assert.ok(option, "打开下拉后应出现项目A的选项");
  option.props.onClick();
  await render(() => panel(props()));
  assert.equal(ls.getItem("dsg:lastWorkspace"), "w1", "手动切换到项目A后，记忆应更新为 w1");
}));