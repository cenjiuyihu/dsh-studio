// dsh-studio — 客户端半边（dsh工作室面板）。
//
// classic script：不 import、不构建，通过 window.__ModuleLoader__.load 注册。
// 可用的 require 静态种子（已从 dsh-web-frontend 的 shell 源码确认）：
//   react / react/jsx-runtime / react-dom / react-dom/client
//   @deepseek-ai/cordis / @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives
// 本文件只用 react + primitives 的**图标**（图标契约确定：<IconX size?>）；其余 UI 用原生元素 +
// 主题变量手写，避免猜测 shipped 组件的 props 契约。
//
// 落点：shell.overlay（左侧抽屉 + 常驻把手；replaceRisk: none，可叠加）与
//       sidebar.footer.action（侧边栏底部开关）。两者共用**一个**槽位条目，避免相同 id 互相顶替。
//
// S1 成员台 / S2 锁定 / S3 置顶已实现；群聊（S4+）在面板上标为「待实现」。

;(function () {
  "use strict";

  const PLUGIN_ID = "dsh-studio";
  const VERSION = "0.1.0";
  const API = "/api/dsh-studio";
  const UI_KEY = "dsh.studio.ui";
  const VIEW_KEY = "dsh.workspace.view.v5";
  const STATUS_KEY = "__DSH_STUDIO__";
  const PREFIX = "[dsh-studio]";

  /** 成员颜色标签色板：只存 key，渲染时映射成具体颜色。 */
  const PALETTE = [
    { key: "slate", label: "石墨", color: "#8a8f98" },
    { key: "blue", label: "靛蓝", color: "#4c8dff" },
    { key: "green", label: "松绿", color: "#3fb950" },
    { key: "amber", label: "琥珀", color: "#d29922" },
    { key: "rose", label: "玫红", color: "#e5534b" },
    { key: "violet", label: "紫罗兰", color: "#a371f7" },
    { key: "cyan", label: "青碧", color: "#39c5cf" },
    { key: "orange", label: "橘", color: "#f0883e" },
  ];
  const COLOR_OF = Object.fromEntries(PALETTE.map((entry) => [entry.key, entry.color]));

  // 只用 56 个真实存在的主题变量（从 shipped CSS 里提取出来的清单）。
  const C = {
    bg: "var(--dsw-alias-bg-layer-1)",
    bg2: "var(--dsw-alias-bg-layer-2)",
    border: "var(--dsw-alias-border-l2)",
    borderSoft: "var(--dsw-alias-border-l1)",
    label: "var(--dsw-alias-label-primary)",
    label2: "var(--dsw-alias-label-secondary)",
    label3: "var(--dsw-alias-label-tertiary)",
    hover: "var(--dsw-alias-interactive-bg-hover)",
    error: "var(--dsw-alias-state-error-primary)",
    warn: "var(--dsw-alias-state-warn-primary)",
    ok: "var(--dsw-alias-state-success-primary)",
  };

  // ───────────────────────────── 极简外部 store ─────────────────────────────
  // 侧边栏按钮与浮层抽屉共享同一份状态；用 useState+useEffect 订阅（不依赖 useSyncExternalStore）。
  function createStore(initial) {
    let state = initial;
    const listeners = new Set();
    return {
      get: () => state,
      set(patch) {
        const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
        if (next === state) return;
        state = next;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            console.warn(PREFIX, "listener failed", error);
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  function useStore(store) {
    const React = buildPlugin.React;
    const [snapshot, setSnapshot] = React.useState(store.get);
    React.useEffect(
      () => store.subscribe(() => setSnapshot(store.get())),
      [store],
    );
    return snapshot;
  }

  function readUiPrefs() {
    const fallback = {
      open: false,
      tab: "members",
      pinInSidebar: true,
      tintRows: true,
      hideInSession: true,
      // ★ 群聊整轮隔离（一条明确需求：群聊回合要与单会话视图清晰隔离）：
      //   群聊产生的回合**整段收起**（含成员对群聊的回复），只留一行摘要，**点摘要可展开**。
      //   动机：成员对有群的回复原本是完整显示的，于是在"用户 ↔ 该成员"的一对一会话里，
      //   看起来就像成员在跟用户说话，把正常对话挤下去。
      //   注意这是**可见层**的隔离：记忆仍是同一份会话日志，成员照常参与群聊。
      isolateGroupTurns: true,
      // 回执状态点（📨 已送达 / 📝 已回执 / ✅ 已交付）默认开：它只是一个视觉标记，不发任何消息。
      showReceipts: true,
      // 0 = 自动（按窗口自适应）；>0 = 用户拖右边框定过的宽度（会记住）
      dockWidth: 0,
    };
    try {
      const raw = window.localStorage.getItem(UI_KEY);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return {
        open: parsed.open === true,
        tab: parsed.tab === "chat" ? "chat" : "members",
        pinInSidebar: parsed.pinInSidebar !== false,
        tintRows: parsed.tintRows !== false,
        hideInSession: parsed.hideInSession !== false,
        isolateGroupTurns: parsed.isolateGroupTurns !== false,
        showReceipts: parsed.showReceipts !== false,
        dockWidth: Number.isFinite(Number(parsed.dockWidth)) && Number(parsed.dockWidth) > 0 ? Number(parsed.dockWidth) : 0,
      };
    } catch {
      return fallback;
    }
  }

  function writeUiPrefs(state) {
    try {
      window.localStorage.setItem(
        UI_KEY,
        JSON.stringify({
          open: state.open === true,
          tab: state.tab,
          pinInSidebar: state.pinInSidebar !== false,
          tintRows: state.tintRows !== false,
          hideInSession: state.hideInSession !== false,
          isolateGroupTurns: state.isolateGroupTurns !== false,
          showReceipts: state.showReceipts !== false,
          dockWidth: Number.isFinite(Number(state.dockWidth)) ? Number(state.dockWidth) : 0,
        }),
      );
    } catch {
      /* 不可用时只是不记忆开合状态 */
    }
  }

  // ─────────────── 群聊时间线：已读位置（"跳到最近未读"用）───────────────
  const TIMELINE_READ_KEY = "dsh.studio.timeline.read";

  /** 上次读到的时间点（ISO 字符串）。缺失 = 从没读过。 */
  function readTimelineMark() {
    try {
      const raw = window.localStorage.getItem(TIMELINE_READ_KEY);
      return typeof raw === "string" && raw.length > 0 ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  function writeTimelineMark(at) {
    try {
      window.localStorage.setItem(TIMELINE_READ_KEY, at);
    } catch {
      /* 忽略 */
    }
  }

  /** 侧边栏当前排序模式：「手动排序」才看得见 workspace 账户顺序。 */
  function readSidebarOrderBy() {
    try {
      const raw = window.localStorage.getItem(VIEW_KEY);
      if (raw === null) return undefined;
      const parsed = JSON.parse(raw);
      return typeof parsed.orderBy === "string" ? parsed.orderBy : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────── S4 群时间线（客户端记录 + localStorage）─────────────────────
  //
  // 为什么时间线在客户端而不是宿主：
  //   宿主的 cordis-plugin-hmr 只监视 profile 目录下的文件（`base`/`root` 配置），
  //   而本插件源码在 profile 目录之外（经 junction 进入 profile），**宿主半边改代码不会热重载**
  //   （实测：改 src/index.js 后路由仍 404，触碰 cordis.patch.yml 也不触发）。
  //   而客户端 bundle 会被宿主重新读取、页面刷新即生效 —— 所以 S4 的记录器放在客户端。
  //
  // 数据来源：connection.api.subscribeEnvelopes 的**原始下行信封** tap。
  //   宿主把每个存活会话的 session/event 广播给每条 mux 连接（apiproxy 的 ctx.on('session/event')），
  //   而客户端运行时只会把帧投给"已实例化"的会话（未实例化的帧被丢弃）——
  //   信封级 tap 早于那层路由，所以不切换视图也能看到成员会话的消息。
  const TIMELINE_KEY = "dsh.studio.timeline";
  const TIMELINE_VERSION = 4;
  /** 时间线条数上限（比早期版本大得多：刷新后能看到更久之前的往来）。 */
  const MAX_TIMELINE = 800;
  const MAX_TIMELINE_TEXT = 2000;
  /** localStorage 通常只有 ~5MB：持久化时按字符数再压一次（超了就丢最旧的 10%）。 */
  const MAX_TIMELINE_STORE_CHARS = 2000000;

  function loadTimeline() {
    try {
      const raw = window.localStorage.getItem(TIMELINE_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw);
      // 记录规则变过（v1 记的是成员会话的全部消息，v2 只记群聊产生的消息）：
      // 版本不符就丢掉旧条目，否则会看到不符合当前规则的残留。
      if (parsed === null || typeof parsed !== "object" || parsed.v !== TIMELINE_VERSION) return [];
      if (!Array.isArray(parsed.items)) return [];
      return parsed.items
        .filter((item) => item !== null && typeof item === "object" && typeof item.id === "string")
        .slice(-MAX_TIMELINE);
    } catch {
      return [];
    }
  }

  let timelineSaveTimer;
  /** 落盘合并：500ms 内的多条消息只写一次；保存的是**触发时**的最新列表（避免闭包里的旧值）。 */
  function scheduleTimelineSave(getList) {
    if (timelineSaveTimer !== undefined) return;
    timelineSaveTimer = window.setTimeout(() => {
      timelineSaveTimer = undefined;
      try {
        let items = getList().slice(-MAX_TIMELINE);
        let payload = JSON.stringify({ v: TIMELINE_VERSION, items });
        // 上限保护：localStorage 写满会直接抛，所以超限时从最旧的开始丢。
        while (payload.length > MAX_TIMELINE_STORE_CHARS && items.length > 1) {
          items = items.slice(Math.max(1, Math.ceil(items.length / 10)));
          payload = JSON.stringify({ v: TIMELINE_VERSION, items });
        }
        window.localStorage.setItem(TIMELINE_KEY, payload);
      } catch (error) {
        console.warn(PREFIX, "timeline persist failed", error);
      }
    }, 500);
  }

  function clearTimelineStorage() {
    if (timelineSaveTimer !== undefined) {
      window.clearTimeout(timelineSaveTimer);
      timelineSaveTimer = undefined;
    }
    try {
      window.localStorage.removeItem(TIMELINE_KEY);
    } catch {
      /* 忽略 */
    }
  }

  // ───────────────── 侧边栏嵌入 / 会话行标注（全部可逆，且不改 React 状态）─────────────────
  //
  // 两条约束逼出了这套做法：
  //   1. 主框架只有三列 + 一个浮层（root: sidebar / conversation / details / shell.overlay），
  //      `details` 已被产品的 DetailsPanel 占用 —— **没有第四列可注册**，所以"嵌入"只能靠
  //      让中列让出空间（CSS）+ 面板停在侧边栏右侧，而不是覆盖会话列表。
  //   2. 产品的会话行**没有任何标识属性**（只有 hashed class / role="treeitem" / aria-selected），
  //      要按 sessionId 上色只能从 React fiber 里读 —— 见 sessionIdOfRow()。
  //
  // 纪律：只读 fiber（不调用、不修改任何 React 内部状态）；只给**自己**的锚点属性与自己的
  // <style> 标签；任何异常都吞掉（绝不能让侧边栏因为本插件出错）。

  const CSS_TAG_ID = "dsh-studio/css";
  const DOCK_ATTR = "data-dsh-studio-dock";
  const ROW_ATTR = "data-dsh-studio-member";
  const SEP_ATTR = "data-dsh-studio-sep";
  // 注意：这几个属性名必须留在**模块作用域**——模块级的 buildSidebarCss 会引用它们。
  // （曾经把 HIDDEN_ATTR 放在 buildPlugin 里，导致 buildSidebarCss 抛 ReferenceError，
  //   整张样式表写不进去，让位/灰底/彩点/置顶/隐藏全部静默失效。）
  const HIDDEN_ATTR = "data-dsh-studio-hidden";
  /** 群聊消息本体不整段隐藏，而是**压成一行**（消息头那一行正好是"来自谁、什么类型"的摘要）。 */
  const CLAMP_ATTR = "data-dsh-studio-clamped";
  /**
   * 「这条是**从别的会话投进来的**群聊消息」标记。
   *
   * 为什么必须有它：群聊消息是以 `user/message` 事件投进目标会话的，产品会把它们渲染成
   * **人类自己输的消息气泡** —— 用户实测反馈"教练发给你的消息出现在你和我的会话里，
   * 看起来像我发的，这算泄露"。所以这里给它们打标记 + 换样式（压成一行、左侧竖条、加 📨 前缀），
   * 让人一眼区分"这是别的会话进来的"和"这是我自己打的"。
   */
  const GROUPMSG_ATTR = "data-dsh-studio-groupmsg";
  /**
   * ★ 群聊整轮隔离（2026-09-22）：属于"群聊回合"的**其余节点**（成员的回复 / 工具调用 / 回合尾）。
   * 与 `GROUPMSG_ATTR` 的区别：那个标记"投进来的那一条"，这个标记"由它引发的一整轮其余部分"。
   * 加了这个属性的节点在对话视图里 `display:none`；点摘要行则把它们从 `openedGroupTurns` 里放行。
   */
  const GROUPTURN_ATTR = "data-dsh-studio-groupturn";
  /** 摘要行可点（点击 = 展开/收起这一轮群聊）。 */
  const GROUPTOGGLE_ATTR = "data-dsh-studio-grouptoggle";
  /** 这一轮群聊当前是"已展开"（由用户点击产生，只影响显示）。 */
  const GROUP_OPEN_ATTR = "data-dsh-studio-groupopen";
  /** 连续多少次解析不出 sessionId 才撤标（滞回，见 decorateSidebar 的说明）。 */
  const MISS_ATTR = "data-dsh-studio-miss";
  const MISS_LIMIT = 3;
  /** 可核对的读数：已标注的行数 / 没解析出的行数（写在 html 上）。 */
  const ANCHORS_ATTR = "data-dsh-studio-anchors";
  const UNRESOLVED_ATTR = "data-dsh-studio-unresolved";
  /**
   * 成员行在侧栏里的排序基准（2026-10-11 用户口径）。
   *
   * 用户要求：**交接后新会话要顶在旧会话原来那一格**、标题也一样 —— 让交接对用户"无感"。
   * 但原先的 CSS 只把所有成员行统一 `order:-2`（一起提到非成员行之上），**成员之间没有次序**，
   * 于是仍按"最近更新"排 ⇒ 刚接任、刚被唤醒的新会话会蹿到成员组最前面，而不是原来那一格。
   * 现在改成按**成员表顺序**（pinned → order → sessionId，与成员台面板一致）逐行给一个互不相同的
   * 整数：基准足够负 ⇒ 仍在非成员行（--3 / -1）之上；而交接时 `order` 是被继承的 ⇒
   * 新会话自然落在旧会话那一格（退役记录因为 order 被沉底，自然排到成员组末尾）。
   */
  const MEMBER_ORDER_BASE = -100000;
  /**
   * 请求"重新跑一遍单会话隐藏"。由 `apply()` 装上实现（那里才够得着调度器）；
   * 点击摘要行时调用一次，让展开/收起立刻生效，不必等下一次 DOM 变更。
   */
  let groupTurnRefresh = null;
  /**
   * 被用户手动展开过的群聊回合（按群聊短 id）。**放模块作用域**：
   * 展开状态必须跨渲染存活，否则下一次"重新标记"就会把它又收起来。
   */
  const openedGroupTurns = new Set();
  /** 让位模式：`push`（挤开一段留白）或 `overlay`（窗口太窄，改为浮层，不占会话列）。 */
  const DOCK_MODE_ATTR = "data-dsh-studio-dock-mode";
  /** 面板理想宽度 / 最小宽度 / 会话列必须保住的最小宽度（自适应让位的三个常量）。 */
  const DOCK_WIDTH_IDEAL = 384;
  // 实测反馈："全屏下不覆盖，小窗口下会话被工作室盖住" —— 上一版把最小宽设成 260、
  // 会话列保底 360，于是窗口 ≤ 820px 就切成**浮层（盖住会话）**。现在改成"**优先把面板压窄**"：
  // 面板可以缩到 180px，会话列只保 220px，只有窗口窄到 ~680px 以下才退回浮层。
  const DOCK_WIDTH_MIN = 180;
  const DOCK_CONVERSATION_MIN = 220;

  function ensureStyleTag() {
    let tag = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
    if (tag === null) {
      tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", CSS_TAG_ID);
      document.head.appendChild(tag);
    }
    return tag;
  }

  /**
   * 从一个会话行元素里读出它的 sessionId。
   *
   * 三条路径，按可靠性排序（2026-09-22 加固，用户报"收起后不置顶、展开才重新置顶"）：
   *   ① **React fiber**：沿 fiber 往上找 `props.node` / `props.row`（`SessionNodeItem` 那层的 props 上就有 node.id）。
   *      原来只认这两个字段、只走 20 层 —— 折叠/展开是**两套渲染路径**，fiber 形状可能不同，
   *      于是同一行在"展开态"解析得到、在"收起态"解析不到 ⇒ **属性打不上 ⇒ 看起来就是不置顶**。
   *      现在多认几个字段名（`item` / `session` / `data` / `props.sessionId`）并把深度放宽到 30。
   *   ② **DOM 属性回退**：行自身与近邻祖先（6 层）的任何属性值里若出现 `session-xxxx` 形态的 id，就用它。
   *      纯读取、不依赖 fiber —— 这条让"产品换了渲染路径"时仍能标注。
   *   ③ 行内链接/属性（`[href*="session-"]`、`[data-session-id]`、`id^=session-`）。
   *
   * ⚠️ **读不到时不要立刻撤标**（调用方处理）：一次解析失败可能只是"这一帧还没把 props 挂上"，
   * 立刻撤标就会表现为"置顶闪一下没了"。所以撤标带**滞回**（见 decorateSidebar 的 MISS_LIMIT）。
   */
  const SESSION_ID_RE = /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

  function sessionIdOfRow(element) {
    // ① fiber
    try {
      const key = Object.keys(element).find(
        (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
      );
      let node = key === undefined ? undefined : element[key];
      let depth = 0;
      while (node !== undefined && node !== null && depth < 30) {
        const props = node.memoizedProps;
        if (props !== null && typeof props === "object") {
          if (typeof props.sessionId === "string" && SESSION_ID_RE.test(props.sessionId)) return props.sessionId;
          for (const field of ["node", "row", "item", "session", "data"]) {
            const candidate = props[field];
            if (candidate === null || typeof candidate !== "object") continue;
            if (typeof candidate.id === "string" && SESSION_ID_RE.test(candidate.id)) return candidate.id;
            const nested = candidate.session;
            if (nested !== null && typeof nested === "object" && typeof nested.id === "string" && SESSION_ID_RE.test(nested.id)) {
              return nested.id;
            }
          }
        }
        node = node.return;
        depth += 1;
      }
    } catch {
      /* fiber 形状变了就往下走别的路径 */
    }
    // ② DOM 属性回退（自身 + 近邻祖先）
    try {
      let el = element;
      for (let up = 0; up < 6 && el !== null; up += 1) {
        for (const attribute of el.attributes !== undefined ? [...el.attributes] : []) {
          const match = SESSION_ID_RE.exec(String(attribute.value ?? ""));
          if (match !== null) return match[0];
        }
        el = el.parentElement;
      }
    } catch {
      /* 忽略 */
    }
    // ③ 行内链接 / 数据属性
    try {
      const inner = element.querySelector('[href*="session-"], [data-session-id], [id^="session-"]');
      if (inner !== null) {
        const raw = inner.getAttribute("href") ?? inner.getAttribute("data-session-id") ?? inner.id ?? "";
        const match = SESSION_ID_RE.exec(String(raw));
        if (match !== null) return match[0];
      }
    } catch {
      /* 忽略 */
    }
    return undefined;
  }

  /** 框架的四个 DOM 子节点（结构定位，不依赖 hashed 类名）。 */
  function frameParts() {
    const layer = document.querySelector("[data-shell-overlay]");
    if (layer === null) return undefined;
    const frame = layer.parentElement;
    if (frame === null || frame.children.length < 3) return undefined;
    return { layer, frame, sidebar: frame.children[0], center: frame.children[1] };
  }

  /**
   * 侧边栏相关的全部样式。三条规则分别对应三件事：
   *   1. 面板打开时**让中列右移** —— 视觉上等于把工作室嵌进主窗口，而不是盖住会话列表；
   *   2. 成员会话行：淡灰底 + 彩色圆点（颜色来自成员自己的色板 key）；
   *   3. 成员会话在分组内置顶（表头 -3 → 成员 -2 → 分隔条 -1 → 普通会话 0），需要先把分组容器变成 flex 列。
   * 全部只靠属性选择器与结构选择器，不依赖产品的 hashed 类名。
   */
  function buildSidebarCss(colorRules, prefs) {
    const hoist = prefs.pinInSidebar !== false;
    const tint = prefs.tintRows !== false;
    const lines = [
      // 0) 群聊消息在单会话视图里的处理：
      //    · 从别的会话投进来的那条 → 压成一行 + 左侧竖条 + `📨 跨会话 ·` 前缀（别再像"我发的"）
      //    · 该回合的其余节点**保持原样**（曾经整段隐藏，会把"我回给人的话"一起藏掉）
      `[${HIDDEN_ATTR}]{display:none!important;}`,
      `[${CLAMP_ATTR}]{max-height:34px;overflow:hidden;opacity:.6;}`,
      // 群聊消息（从别的会话投进来的）：**压成一行 + 左侧竖条 + 前缀标记**，
      // 让它一眼区别于"人自己打的"气泡（用户报过"看起来像我发的，这算泄露"）。
      `[${GROUPMSG_ATTR}]{max-height:34px;overflow:hidden;opacity:.75;border-left:3px solid var(--dsw-alias-label-tertiary);border-radius:3px;padding-left:6px;background:rgba(125,135,150,.10);}`,
      `[${GROUPMSG_ATTR}]::before{content:"📨 跨会话 · ";font-size:11px;opacity:.85;}`,
      `[${GROUPMSG_ATTR}]:hover{max-height:none;opacity:1;}`,
      // ★ 群聊整轮隔离（一条明确需求：群聊回合要与单会话视图清晰隔离）：
      //   该回合的**其余部分**（成员的回复 / 工具调用 / 回合尾）整段不显示；
      //   摘要行保留并变成可点的开关 —— 点它才展开这一轮。
      `[${GROUPTURN_ATTR}]{display:none!important;}`,
      `[${GROUPTOGGLE_ATTR}]{cursor:pointer;}`,
      `[${GROUPTOGGLE_ATTR}]:not([data-dsh-studio-groupopen="1"])::after{content:"　（点击展开这一轮）";font-size:11px;opacity:.6;}`,
      `[${GROUPTOGGLE_ATTR}][data-dsh-studio-groupopen="1"]::after{content:"　（点击收起）";font-size:11px;opacity:.6;}`,
      `[${GROUPTOGGLE_ATTR}][data-dsh-studio-groupopen="1"]{max-height:none;opacity:1;}`,
      // 1) 让位（只有 html 上带 open 标记、且不是浮层模式时才生效）
      //    ★ 宽度是**自适应**的：窗口窄到放不下"侧边栏 + 面板 + 可读的会话列"时，
      //      自动改用浮层模式（data-dsh-studio-dock-mode=overlay 时这条规则不匹配），
      //      绝不把会话列挤到看不见 —— 用户报过"打开工作室后看不到消息"。
      `html[${DOCK_ATTR}="open"]:not([${DOCK_MODE_ATTR}="overlay"]) div:has(> div[data-shell-overlay]) > div:nth-child(2){margin-left:var(--dsh-studio-dock-width,384px);}`,
      colorRules,
    ];
    if (tint) {
      lines.push(
        `[${ROW_ATTR}] > [role="treeitem"]{background:rgba(125,135,150,.16);border-radius:8px;}`,
        `[${ROW_ATTR}] > [role="treeitem"]:hover{background:rgba(125,135,150,.26);}`,
        `[${ROW_ATTR}] > [role="treeitem"]::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsh-studio-member-color,#8a8f98);margin-right:5px;}`,
      );
    }
    if (hoist) {
      lines.push(
        // 分组容器：直接含有成员行包装的容器切成 flex 列，才能用 order 排序。
        `div:has(> [${ROW_ATTR}]){display:flex!important;flex-direction:column!important;}`,
        // 工作区表头（projectRow 的包装层）**也在同一个容器里**，必须比成员更靠前，
        // 否则成员会被顶到表头之上 —— 表头给 -2、成员给 -1、其余保持 0。
        // 排序用整数层级（order 只接受整数，-0.5 会被丢弃）：
        //   表头 -3 → 成员 -2 → 分隔条 -1 → 普通会话 0
        `div:has(> [${ROW_ATTR}]) > :has(> [role="treeitem"]:not([class*="sessionRow"])){order:-3;}`,
        `[${ROW_ATTR}]{order:-2;}`,
        `[${SEP_ATTR}]{order:-1;flex:none;height:1px;margin:6px 10px;background:var(--dsw-alias-border-l2);}`,
      );
    }
    return lines.filter((line) => line.length > 0).join("\n");
  }

  // ───────────────────────────── 宿主 RPC ─────────────────────────────

  async function callHost(method, payload) {
    const response = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (body === null || typeof body !== "object" || body.ok !== true) {
      const message =
        body !== null && typeof body === "object" && typeof body.error === "string"
          ? body.error
          : `工作室宿主调用失败：${method}（HTTP ${response.status}）`;
      throw new Error(message);
    }
    return body.value;
  }

  function shortId(sessionId) {
    const text = String(sessionId ?? "");
    const bare = text.startsWith("session-") ? text.slice(8) : text;
    return bare.slice(0, 8);
  }

  /**
   * 退役成员判定 —— 与 `src/protocol.js` 的 `isRetired` **同一判据**，两端必须一致：
   *   ① 别名带退役前缀，形如 `旧[<日期>]<别名>`；
   *   ② `locked === false` —— 本项目的"锁定"语义是"禁止归档"，
   *      所以解锁记录就是"随时可归档的旧记录"。
   *
   * 退役记录**继续留在成员表里**（历史消息、寻址、审计都要用到它），
   * 但**不能再当派发目标**：它出现在派发选项里，等于把消息投进一个已经没人读的会话。
   */
  const RETIRED_ALIAS_RE = /^\s*旧[\s·・•\-–—_\[（(【]/;
  function isRetiredMember(member) {
    if (member === null || member === undefined) return false;
    if (member.locked === false) return true;
    return RETIRED_ALIAS_RE.test(String(member.alias ?? ""));
  }

  function memberLabel(member, summary) {
    if (member.alias !== undefined && member.alias.length > 0) return member.alias;
    if (summary !== undefined && typeof summary.displayTitle === "string" && summary.displayTitle.length > 0) {
      return summary.displayTitle;
    }
    return shortId(member.sessionId);
  }

  /**
   * 观测式进度（用户要求的一半；另一半是成员自己 `--progress`）。
   *
   * 为什么能这么干：工作室本来就在监听**所有成员会话**的事件流，工具调用对我们可见 ——
   * `tool/call` 事件的形状实测为 `{turn, step, callId, name:"pwsh"|"edit"|"read"|…, arguments:"<JSON 字符串>"}`。
   * 于是"它执行到哪了"可以**观测**出来，而不是靠猜、也不需要成员配合。
   *
   * 这是 `src/protocol.js` 里 `summarizeToolCall` 的精简副本 —— 客户端 bundle 不能 import
   * （它是普通 script，不是打包产物），所以两边各一份。**改口径时两处都要改**。
   * 委托方（成员「站点成员」）反馈的痛点正是这个：它以前只能自己轮询文件系统与解压 transcript 猜进度。
   */
  function summarizeToolCallLite(name, rawArguments) {
    const tool = String(name ?? "").trim();
    let args = {};
    if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawArguments);
        if (parsed !== null && typeof parsed === "object") args = parsed;
      } catch {
        args = {};
      }
    } else if (rawArguments !== null && typeof rawArguments === "object") {
      args = rawArguments;
    }
    const first = (...candidates) => {
      for (const candidate of candidates) if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
      return undefined;
    };
    const shorten = (value, max = 40) => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);
    const filePath = first(args.file_path, args.path, args.notebook_path, args.filePath);
    const shortPath = filePath !== undefined ? shorten(filePath.split(/[\\/]/).slice(-2).join("/")) : undefined;
    if (/^(edit|write|multi_edit|apply_patch|create_file|str_replace)/i.test(tool)) {
      return { kind: "edit", label: shortPath !== undefined ? `改 ${shortPath}` : `改文件（${tool}）` };
    }
    if (/^(read|grep|glob|list_dir|ls|view)/i.test(tool)) {
      return { kind: "read", label: shortPath !== undefined ? `读 ${shortPath}` : `读文件（${tool}）` };
    }
    if (/^(pwsh|bash|shell|sh|cmd|exec|run_command|terminal)/i.test(tool)) {
      const command = first(args.command, args.cmd, args.script);
      return { kind: "command", label: command !== undefined ? `跑命令：${shorten(command.split("\n")[0])}` : "跑命令" };
    }
    return { kind: "other", label: tool.length > 0 ? `调用 ${tool}` : "调用了一个工具" };
  }

  /** 把一段活动记录变成人能读的一句话（窗口外或没活动就返回 undefined）。 */
  function describeActivity(record, now, windowMs) {    if (record === undefined) return undefined;
    if (now - record.at > windowMs) return undefined;
    const parts = [];
    if (record.edits > 0) parts.push(`${record.edits} 次编辑`);
    if (record.commands > 0) parts.push(`${record.commands} 次命令`);
    if (record.reads > 0) parts.push(`${record.reads} 次阅读`);
    if (parts.length === 0) parts.push(record.others > 0 ? `${record.others} 次工具调用` : "有活动");
    const seconds = Math.max(1, Math.round((now - record.at) / 1000));
    const ago = seconds < 60 ? `${seconds} 秒前` : `${Math.round(seconds / 60)} 分钟前`;
    // 如实标注：工具参数不透明时只说"调用了 X"，绝不硬凑一个文件名。
    return `${parts.join(" · ")}${record.last !== undefined ? `（最近：${record.last}）` : ""} · ${ago}`;
  }


  /** 群聊时间线里的发送者显示名 —— **必须**与 foldTimelineEvent 写 author 的口径完全一致。 */
  function timelineAuthor(member) {
    if (member === undefined) return "";
    return member.alias.length > 0 ? member.alias : shortId(member.sessionId);
  }

  /**
   * 两段式回执协议（用户定的设计，类比 TCP）—— **纯显示**：不发消息、不改任何数据。
   *
   *   ① **接受状态 = 传输层 ACK**：我们能看见这条"投递出去"的消息（`direction === "out"`），
   *      就证明它确实进了对方会话的信箱 —— 所以"已送达"是白拿的，不需要任何人开口，
   *      也不会在会话正文里多出任何文字。
   *   ② **正式回执 = 应用层确认**：由**对方 agent 自己**在"队列排空 → 读完任务 → 动手之前"
   *      发出（`bin/say.mjs --ack` 接单 / `--decline` 推掉），内容是它自己的话。它落进**发起者**的会话，
   *      在时间线上表现为一条更晚的 `out`：author = 收件人、sessionId = 发起者的会话。
   *
   * 这套东西取代了原来那段"脚本式自动回执"（工作室代成员说"已读到"）：
   * 那句是代对方说话、会作为用户消息污染发起者会话、还白占一轮。
   */
  const RECEIPT_STYLE = {
    sent: {
      text: "📨 已送达",
      color: C.label3,
      title: "消息已进入对方会话的信箱（这一层就是 TCP 式接受状态）。它**不保证**对方已经开始处理。",
    },
    acked: {
      text: "📝 已回执",
      color: C.label2,
      title: "对方 agent 读过并表态接单。它的原话（计划/预计时间）就在这条时间线里，别只看这个点。",
    },
    declined: {
      text: "🚫 已推掉",
      color: C.warn,
      title: "对方 agent 明确推掉了这件事 —— 该换人或换路了。",
    },
    delivered: {
      text: "✅ 已交付",
      color: C.ok,
      title: "对方已经交付了产物或结论。",
    },
  };

  /**
   * 群聊卡片的两侧配色 + 两端标签：**左边 = 发起者，右边 = 接收者**（用户要求）。
   *
   *   - `out` 条目 = "某成员发给这个会话"的消息 → 左 = `author`（发起者），右 = 该会话的成员（接收者）。
   *   - `in` 条目 = "这个会话的成员自己的回答" → 左 = 该会话成员，右 = **上一条发给它的消息的发起者**
   *     （也就是它正在回复的那个人）。这样同一条回答也能看出"谁回给谁"，而不是显示成 `X ← X`。
   *   - 人不是成员（例如面板转达的 `我`）→ 退回中性色，不硬套成员色。
   */
  function buildFlowMap(items, members) {
    const colorOfLabel = new Map();
    const labelOfSession = new Map();
    for (const member of members) {
      const label = timelineAuthor(member);
      const color = COLOR_OF[member.color];
      labelOfSession.set(member.sessionId, label);
      if (label.length > 0 && color !== undefined) colorOfLabel.set(label, color);
    }
    const flowOf = new Map();
    for (const message of items) {
      const owner = labelOfSession.get(message.sessionId);
      const ownerLabel = owner !== undefined && owner.length > 0 ? owner : shortId(message.sessionId);
      const ownerColor = colorOfLabel.get(owner) ?? C.label3;
      if (message.direction === "out") {
        flowOf.set(message.id, {
          from: message.author,
          to: ownerLabel,
          fromColor: colorOfLabel.get(message.author) ?? C.label3,
          toColor: colorOfLabel.get(owner) ?? C.borderSoft,
        });
      } else {
        // ★ 成员/本会话**自己的输出**：标题应该是「自己 → 自己」，两侧同色。
        //   曾经把它接成"上一条发给它的那个人"（我当时的想法是"它在回复谁"），但那是**猜**：
        //   会话里的思考与正文本来就是它自己的产出，并不针对某个成员 —— 用户实测指出指向错了。
        //   现在：发起者 = 接收者 = 该会话成员，两侧都用它的颜色。
        flowOf.set(message.id, {
          from: ownerLabel,
          to: ownerLabel,
          fromColor: ownerColor,
          toColor: ownerColor,
        });
      }
    }
    return flowOf;
  }

  /**
   * 广播标记解析（方案 A）：正文首行的 `〖广播 #xxxx〗`。
   *
   * 放在**模块作用域**而不是组件内部 —— 组件里的 `const` 有 TDZ：`useMemo` 在渲染期立刻执行，
   * 若它的回调引用了**后面**才声明的函数，就会抛 `Cannot access 'X' before initialization`
   * 并让整个面板被错误边界拦下（这次就是被它抓到的）。
   */
  function broadcastMarkerOf(text) {
    const parsed = /^〖广播 #([0-9a-zA-Z]{4,12})〗/.exec(String(text ?? "").trim());
    return parsed !== null ? parsed[1] : undefined;
  }

  /** 时间线条目里的 ISO 时间是 UTC；面板原来直接切字符串显示的就是 UTC，和 CLI 的本地时间对不上。 */
  function clockOf(at) {
    const date = new Date(String(at));
    if (Number.isNaN(date.getTime())) return String(at).slice(11, 19);
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * 给群聊时间线算"每条投递出去的消息走到哪一步了"。返回 `Map<时间线条目 id, 状态 key>`。
   *
   * 判定顺序（强 → 弱）：`delivered` > `declined` > `acked` > `sent`。
   * 匹配条件：回执必须满足「收件人发的」+「落在发起者会话里」，或者**短 id 对上**（显式引用最硬）。
   * 只按"之后有没有任意消息"匹配会把别人的回答算到自己头上（`--inbox` 上踩过同一个坑）。
   */
  function buildReceiptMap(items, members) {
    const labelOfSession = new Map();
    const sessionOfLabel = new Map();
    for (const member of members) {
      const label = timelineAuthor(member);
      labelOfSession.set(member.sessionId, label);
      if (label.length > 0) sessionOfLabel.set(label, member.sessionId);
    }
    const map = new Map();
    for (let index = 0; index < items.length; index += 1) {
      const message = items[index];
      // 只有"投递出去"的群聊消息才有回执可言：`in` 是某个会话里 agent 自己的回答，没有投递目标。
      if (message.direction !== "out" || message.kind === "warn") continue;
      const recipient = labelOfSession.get(message.sessionId);
      const requesterSession = sessionOfLabel.get(message.author);
      let state = "sent";
      for (let next = index + 1; next < items.length; next += 1) {
        const later = items[next];
        if (later.direction !== "out") continue;
        const backToRequester = requesterSession !== undefined && later.sessionId === requesterSession;
        const fromRecipient = recipient !== undefined && later.author === recipient;
        const explicitRef = message.ref !== undefined && later.ref === message.ref;
        if (!((backToRequester && fromRecipient) || explicitRef)) continue;
        if (later.kind === "deliver") {
          state = "delivered";
          break;
        }
        if (later.kind === "decline" && state !== "delivered") state = "declined";
        else if (later.kind === "ack" && state === "sent") state = "acked";
      }
      map.set(message.id, state);
    }
    return map;
  }

  /**
   * 观测式进度的共享状态：**必须放在模块作用域**。
   * 面板组件（buildPlugin 作用域）与信封 tap（apply 作用域）都要用它 ——
   * 曾经把它写在 `apply()` 里，结果面板渲染时 `activityBySession is not defined`，
   * 整个面板被产品槽位吞掉、界面凭空消失（已由 PanelBoundary 兜住并显示原因）。
   */
  const activityBySession = new Map();
  /** 活动统计的时间窗：超过这个时间就不再宣称"执行中"（否则会有永远亮着的假进度）。 */
  const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;

  /**
   * 每个会话的**排队深度**（来自 `session/queue` 推帧）。
   *
   * 为什么关心它：实测过一次"队列堆到 11 条"——委托方比被委托方快得多，
   * 消息就堆在后者队列里（每条排队消息都要吃掉对方**一个完整回合**）。
   * 面板把队列深度显示出来，发消息的人就能看见压力，而不是埋头继续发。
   *
   * 帧形状（源码：`api-proxy.queueItems()`）：`items: [{id, placement: 'queued'|'steering'|'context', message}]`。
   */
  const queueDepthBySession = new Map();

  /** 从 `session/queue` 帧里读会话 id（字段拼写在不同版本上不完全一致，一律容错）。 */
  function queueFrameSessionId(payload) {
    if (payload === null || typeof payload !== "object") return "";
    for (const key of ["sessionId", "id", "session"]) {
      const value = payload[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
  }

  /** 从一条排队消息里取一小段文本（只读、只用于诊断显示）。 */
  function summarizeQueuedMessage(message) {
    try {
      const content = message !== null && typeof message === "object" ? message.content : undefined;
      if (!Array.isArray(content)) return "(无正文)";
      const text = content
        .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length === 0) return "(无正文)";
      // 群聊消息压掉前缀，只留"谁发的 + 类型 + 首句"，一眼看出堆积来源。
      // ⚠️ 这里**不能**用 `GROUP_LINE_RE` —— 那个常量定义在 buildPlugin 内部，模块级函数引用它会
      //    抛 ReferenceError（已被作用域守卫的检查 A 覆盖）。所以用自带的正则字面量。
      const parsed = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)(?:｜#([0-9a-zA-Z]{4,12}))?】([\s\S]*)/.exec(text);
      if (parsed !== null) {
        const head = `【${parsed[2]}｜来自 ${parsed[3]}${parsed[4] !== undefined ? `｜#${parsed[4]}` : ""}】`;
        return `${head} ${parsed[5].split("\n")[0].slice(0, 46)}`.slice(0, 96);
      }
      return text.slice(0, 96);
    } catch {
      return "(读取失败)";
    }
  }

  function splitCaps(text) {
    return String(text ?? "")
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  // ───────────────────────────── 样式 ─────────────────────────────

  const styles = {
    launcher: {
      position: "absolute",
      left: 0,
      top: "50%",
      transform: "translateY(-50%)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "10px 5px",
      borderRadius: "0 10px 10px 0",
      border: `1px solid ${C.border}`,
      borderLeft: "none",
      background: C.bg2,
      color: C.label2,
      cursor: "pointer",
      boxShadow: "var(--dsw-shadow-lv3)",
      fontSize: 12,
      writingMode: "vertical-rl",
      letterSpacing: 3,
    },
    drawer: {
      position: "absolute",
      left: "var(--dsh-studio-dock-left, 280px)",
      top: 0,
      bottom: 0,
      width: "var(--dsh-studio-dock-width, 384px)",
      display: "flex",
      flexDirection: "column",
      background: C.bg,
      color: C.label,
      borderRight: `1px solid ${C.border}`,
      boxShadow: "var(--dsw-shadow-lv3)",
      fontFamily: "var(--dsw-font-family)",
      fontSize: 13,
      zIndex: 1,
    },
    header: { display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 8px", borderBottom: `1px solid ${C.borderSoft}` },
    title: { flex: 1, display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 14 },
    tabs: { display: "flex", gap: 4, padding: "8px 12px 0" },
    tab: (active) => ({
      padding: "5px 10px",
      borderRadius: 6,
      border: `1px solid ${active ? C.border : "transparent"}`,
      background: active ? C.bg2 : "transparent",
      color: active ? C.label : C.label3,
      cursor: "pointer",
      fontFamily: "inherit",
      fontSize: 12,
    }),
    body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
    scroller: { flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 12px" },
    dockBottom: {
      borderTop: `1px solid ${C.borderSoft}`,
      background: C.bg2,
      padding: "8px 12px 10px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
    },
    section: { marginBottom: 14 },
    sectionTitle: { fontSize: 11, color: C.label3, marginBottom: 6, letterSpacing: 0.5 },
    banner: {
      margin: "8px 12px 0",
      padding: "7px 10px",
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.5,
      border: `1px solid ${C.border}`,
      background: C.bg2,
      color: C.label2,
    },
    input: {
      width: "100%",
      boxSizing: "border-box",
      padding: "6px 8px",
      borderRadius: 6,
      border: `1px solid ${C.border}`,
      background: C.bg2,
      color: C.label,
      fontFamily: "inherit",
      fontSize: 12,
    },
    card: { border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "8px 10px", marginBottom: 8, background: C.bg2 },
    row: { display: "flex", alignItems: "center", gap: 6 },
    chip: { fontSize: 11, padding: "1px 6px", borderRadius: 4, border: `1px solid ${C.border}`, color: C.label3, whiteSpace: "nowrap" },
    dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, flex: "none" }),
    small: { fontSize: 11, color: C.label3 },
    footer: { borderTop: `1px solid ${C.borderSoft}`, padding: "8px 12px", fontSize: 11, color: C.label3, lineHeight: 1.6 },
    candidate: { display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6 },
  };

  // ───────────────────────────── 组件 ─────────────────────────────

  function buildPlugin(React, primitives) {
    buildPlugin.React = React;
    const I = primitives;
    const Icon = {
      Sparkle: I.IconSparkle16,
      Close: I.IconCloseOutline16,
      Plus: I.IconPlusOutline16,
      Trash: I.IconTrashOutline16,
      Edit: I.IconEditOutline16,
      Refresh: I.IconRefreshOutline16,
      Check: I.IconCheckOutline16,
      Warning: I.IconWarningOutline16,
      Link: I.IconLinkOutline16,
    };

    function Button(props) {
      const [hover, setHover] = React.useState(false);
      const disabled = props.disabled === true;
      const color = disabled ? C.label3 : props.tone === "danger" ? C.error : props.tone === "ok" ? C.ok : C.label2;
      const children = props.children;
      return React.createElement(
        "button",
        {
          type: "button",
          title: props.title,
          disabled,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: children === undefined || children === null ? "4px" : "4px 8px",
            borderRadius: 6,
            border: `1px solid ${hover && !disabled ? C.border : "transparent"}`,
            background: hover && !disabled ? C.hover : "transparent",
            color,
            cursor: disabled ? "default" : "pointer",
            fontFamily: "inherit",
            fontSize: 12,
          },
        },
        props.icon !== undefined ? React.createElement(props.icon, { size: 14 }) : null,
        children,
      );
    }

    function ColorPicker(props) {
      return React.createElement(
        "div",
        { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
        PALETTE.map((entry) =>
          React.createElement("button", {
            key: entry.key,
            type: "button",
            title: entry.label,
            onClick: () => props.onPick(entry.key),
            style: {
              width: 18,
              height: 18,
              borderRadius: 9,
              cursor: "pointer",
              background: entry.color,
              border: props.value === entry.key ? `2px solid ${C.label}` : `1px solid ${C.border}`,
            },
          }),
        ),
      );
    }

    function MemberEditor(props) {
      const { member, onCancel, onSave, busy } = props;
      const [draft, setDraft] = React.useState({
        alias: member.alias,
        color: member.color,
        role: member.role,
        caps: member.caps.join(", "),
      });
      const field = (label, key, placeholder) =>
        React.createElement(
          "label",
          { style: { display: "block", marginBottom: 6 } },
          React.createElement("div", { style: styles.small }, label),
          React.createElement("input", {
            style: styles.input,
            value: draft[key],
            placeholder,
            onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
          }),
        );
      return React.createElement(
        "div",
        { style: { ...styles.card, borderColor: C.border } },
        field("成员别名（只影响工作室面板，不改会话标题）", "alias", "例如：教练成员"),
        field("角色 / 职能", "role", "例如：算法教练 · 模板生成"),
        field("能力标签（逗号分隔）", "caps", "模板生成, 码风分析, 题解评审"),
        React.createElement("div", { style: styles.small }, "颜色标签"),
        React.createElement(
          "div",
          { style: { margin: "4px 0 8px" } },
          React.createElement(ColorPicker, { value: draft.color, onPick: (color) => setDraft({ ...draft, color }) }),
        ),
        React.createElement(
          "div",
          { style: { display: "flex", gap: 6 } },
          React.createElement(
            Button,
            {
              icon: Icon.Check,
              disabled: busy,
              onClick: () =>
                onSave({ alias: draft.alias, color: draft.color, role: draft.role, caps: splitCaps(draft.caps) }),
            },
            "保存",
          ),
          React.createElement(Button, { onClick: onCancel }, "取消"),
        ),
      );
    }


      function MemberRow(props) {
      const { member, summary, onToggleLock, onTogglePin, onEdit, onRemove, onSyncSidebar, syncHint, busy, activity, queue } = props;
      const color = COLOR_OF[member.color] ?? C.label3;
      const running = summary !== undefined && summary.running === true;
      return React.createElement(
        "div",
        { style: styles.card },
        React.createElement(
          "div",
          { style: styles.row },
          React.createElement("span", { style: styles.dot(color) }),
          React.createElement(
            "span",
            { style: { fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            memberLabel(member, summary),
          ),
          running ? React.createElement("span", { style: { ...styles.chip, color: C.ok } }, "运行中") : null,
          // 排队深度：每条排队消息都要吃掉对方一个完整回合 —— 堆起来就是"发得太快、处理不过来"。
          queue !== undefined && queue.queued > 0
            ? React.createElement(
                "span",
                { style: { ...styles.chip, color: queue.queued >= 5 ? C.error : C.warn }, title: "排队中、尚未开始的回合数（steering/context 不计）" },
                `队列 ${queue.queued} 条`,
              )
            : null,
          activity !== undefined ? React.createElement("span", { style: { ...styles.chip, color: C.warn }, title: "观测到的最近工具调用（工作室监听会话事件流得到的事实，不是推测）" }, "⏳ 有活动") : null,
          React.createElement(
            Button,
            {
              icon: member.locked ? undefined : Icon.Warning,
              title: member.locked ? "已锁定：归档会被阻止（点击解锁）" : "未锁定：可能被一键归档，且 DSH 当前版本没有反归档 API（点击锁定）",
              tone: member.locked ? "ok" : "danger",
              disabled: busy,
              onClick: () => onToggleLock(!member.locked),
            },
            member.locked ? "已锁" : "未锁",
          ),
          React.createElement(
            Button,
            { title: "在工作室面板内置顶", disabled: busy, onClick: () => onTogglePin(!member.pinned) },
            member.pinned ? "已置顶" : "置顶",
          ),
          React.createElement(Button, { icon: Icon.Edit, title: "编辑别名 / 颜色 / 角色 / 能力", disabled: busy, onClick: onEdit }),
          React.createElement(Button, { icon: Icon.Trash, title: "从工作室移除（不动会话本身）", tone: "danger", disabled: busy, onClick: onRemove }),
        ),
        React.createElement(
          "div",
          { style: { ...styles.small, marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          member.role.length > 0 ? React.createElement("span", null, member.role) : null,
          member.caps.map((cap) => React.createElement("span", { key: cap, style: styles.chip }, cap)),
          React.createElement("span", { style: { opacity: 0.7 } }, `#${shortId(member.sessionId)}`),
        ),
        member.pinned
          ? React.createElement(
              "div",
              { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
              React.createElement(Button, { icon: Icon.Link, disabled: busy, onClick: onSyncSidebar }, "同步到侧边栏顶部"),
              syncHint !== undefined ? React.createElement("span", { style: { ...styles.small, color: C.warn } }, syncHint) : null,
            )
          : null,
        // 观测式进度：它最近在干什么（来自真实工具调用，不是推测）。
        activity !== undefined
          ? React.createElement(
              "div",
              { style: { ...styles.small, marginTop: 6, color: C.warn }, title: "工作室监听所有成员会话的事件流得到的事实；工具参数不透明时只写「调用了 X」" },
              `⏳ 执行中：${activity}`,
            )
          : null,
      );
    }

    function MembersTab(props) {
      const { store, state, workspacesService, useSessionsHook, useWorkspacesHook } = props;
      const list = useSessionsHook((snapshot) => snapshot);
      const workspaceState = useWorkspacesHook((snapshot) => snapshot);
      const [filter, setFilter] = React.useState("");
      const [editing, setEditing] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const [localNotice, setLocalNotice] = React.useState(undefined);

      const members = state.data === null ? [] : state.data.members;
      const memberIds = new Set(members.map((member) => member.sessionId));
      const byId = list !== undefined && list.byId !== undefined ? list.byId : {};
      // 观测式进度需要定期刷新（工具调用不进 store，避免高频重绘）；1.5s 与面板的活动一致。
      const [activityTick, setActivityTick] = React.useState(0);
      React.useEffect(() => {
        const timer = window.setInterval(() => setActivityTick((value) => value + 1), 1500);
        return () => window.clearInterval(timer);
      }, []);
      const activityOf = (sessionId) => describeActivity(activityBySession.get(sessionId), Date.now(), ACTIVITY_WINDOW_MS);
      void activityTick;
      // WorkspaceListState 的字段名是 `items`（见 ui-workspace 里 `useWorkspaces((state) => state.items)`）。
      const workspaceItems =
        workspaceState !== undefined && Array.isArray(workspaceState.items)
          ? workspaceState.items
          : workspaceState !== undefined && Array.isArray(workspaceState.workspaces)
            ? workspaceState.workspaces
            : [];
      const workspaces = workspaceItems;

      const query = filter.trim().toLowerCase();
      const candidates = (list !== undefined && Array.isArray(list.ids) ? list.ids : [])
        .filter((id) => !memberIds.has(id))
        .map((id) => byId[id])
        .filter((summary) => summary !== undefined)
        .filter((summary) => {
          if (query.length === 0) return true;
          const title = String(summary.displayTitle ?? "").toLowerCase();
          return title.includes(query) || String(summary.id).toLowerCase().includes(query);
        })
        .slice(0, 12);

      const guard = async (action) => {
        setBusy(true);
        try {
          await action();
        } catch (error) {
          store.set({ error: error instanceof Error ? error.message : String(error) });
        } finally {
          setBusy(false);
        }
      };

      /** 侧边栏呈现开关（成员行淡灰底 / 分组内置顶）。 */
      const togglePref = (key) => {
        const next = !(store.get()[key] !== false);
        store.set({ [key]: next });
        writeUiPrefs({ ...store.get(), [key]: next });
      };

      const upsert = (input) =>
        guard(async () => {
          const value = await callHost("member/upsert", input);
          store.set((prev) => ({ ...prev, data: value.state, error: null }));
        });

      const remove = (sessionId) =>
        guard(async () => {
          const value = await callHost("member/remove", { sessionId });
          store.set((prev) => ({ ...prev, data: value.state, error: null }));
          setEditing(undefined);
        });

      /** S3：把成员真正挪到侧边栏 workspace 账户最前（走产品自己的 RPC，合法且可逆）。 */
      const syncSidebar = (sessionId) =>
        guard(async () => {
          // 注意：必须用 apply() 里 ctx.get('workspaces') 拿到的服务对象，
          // 不能在组件里写 ctx.workspaces —— 那需要声明 inject，否则会抛
          // `cannot get property "workspaces" without inject`。
          if (workspacesService === undefined || typeof workspacesService.insertSessionBefore !== "function") {
            setLocalNotice("workspaces 服务不可用，无法同步到侧边栏顺序。");
            return;
          }
          const workspace = workspaces.find(
            (entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId),
          );
          if (workspace === undefined) {
            setLocalNotice("该会话不在任何 workspace 账户上，无法同步到侧边栏顺序。");
            return;
          }
          if (workspace.sessionIds[0] === sessionId) {
            setLocalNotice("它已经在侧边栏顺序的第一位。");
            return;
          }
          await workspacesService.insertSessionBefore(workspace.workspaceId, sessionId, workspace.sessionIds[0]);
          setLocalNotice(
            readSidebarOrderBy() === "updated"
              ? "已写入 workspace 顺序；侧边栏当前是「最近更新」排序 —— 切到「手动排序」才看得见。"
              : "已同步到侧边栏顶部。",
          );
        });

      return React.createElement(
        React.Fragment,
        null,
        localNotice !== undefined ? React.createElement("div", { style: styles.banner }, localNotice) : null,
        React.createElement(
          "div",
          { style: styles.section },
          React.createElement("div", { style: styles.sectionTitle }, `成员（${members.length}）`),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
            React.createElement(
              Button,
              { disabled: busy, title: "成员会话在侧边栏各工作区分组内置顶", onClick: () => togglePref("pinInSidebar") },
              state.pinInSidebar !== false ? "侧边栏置顶：开" : "侧边栏置顶：关",
            ),
            React.createElement(
              Button,
              { disabled: busy, title: "成员会话行用淡灰底 + 彩色圆点区分", onClick: () => togglePref("tintRows") },
              state.tintRows !== false ? "成员行标记：开" : "成员行标记：关",
            ),
          ),
          members.map((member) =>
            editing === member.sessionId
              ? React.createElement(MemberEditor, {
                  key: member.sessionId,
                  member,
                  busy,
                  onCancel: () => setEditing(undefined),
                  onSave: (patch) =>
                    upsert({ sessionId: member.sessionId, ...patch }).then(() => setEditing(undefined)),
                })
              : React.createElement(MemberRow, {
                  key: member.sessionId,
                  member,
                  busy,
                  summary: byId[member.sessionId],
                  activity: activityOf(member.sessionId),
                  queue: queueDepthBySession.get(member.sessionId),
                  syncHint: member.pinned && readSidebarOrderBy() === "updated" ? "侧边栏需切到手动排序" : undefined,
                  onToggleLock: (next) => upsert({ sessionId: member.sessionId, locked: next }),
                  onTogglePin: (next) => upsert({ sessionId: member.sessionId, pinned: next }),
                  onEdit: () => setEditing(member.sessionId),
                  onRemove: () => remove(member.sessionId),
                  onSyncSidebar: () => syncSidebar(member.sessionId),
                }),
          ),
          members.length === 0
            ? React.createElement("div", { style: styles.small }, "还没有成员。在下面搜索一个会话并「提升」即可。")
            : null,
        ),
        React.createElement(
          "div",
          { style: styles.section },
          React.createElement("div", { style: styles.sectionTitle }, "提升会话为成员"),
          React.createElement("input", {
            style: styles.input,
            placeholder: "搜索会话标题或 id…",
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          }),
          React.createElement(
            "div",
            { style: { marginTop: 6 } },
            candidates.map((summary) =>
              React.createElement(
                "div",
                {
                  key: summary.id,
                  style: styles.candidate,
                  onMouseEnter: (event) => {
                    event.currentTarget.style.background = C.hover;
                  },
                  onMouseLeave: (event) => {
                    event.currentTarget.style.background = "transparent";
                  },
                },
                React.createElement(
                  "span",
                  { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  summary.displayTitle ?? summary.id,
                ),
                React.createElement("span", { style: { ...styles.small, flex: "none" } }, `#${shortId(summary.id)}`),
                summary.running === true ? React.createElement("span", { style: { ...styles.chip, color: C.ok } }, "运行中") : null,
                React.createElement(
                  Button,
                  {
                    icon: Icon.Plus,
                    disabled: busy,
                    title: "提升为成员（默认锁定）",
                    onClick: () =>
                      upsert({
                        sessionId: summary.id,
                        alias: "",
                        color: PALETTE[members.length % PALETTE.length].key,
                        locked: true,
                      }),
                  },
                  "提升",
                ),
              ),
            ),
            candidates.length === 0
              ? React.createElement(
                  "div",
                  { style: styles.small },
                  query.length === 0 ? "（没有更多可提升的会话）" : "（没有匹配的会话）",
                )
              : null,
          ),
        ),
      );
    }

    /**
     * 群消息前缀的**构造**侧（解析侧见下面的 GROUP_LINE_RE，格式必须一致）：
     *   【群聊·<群名>｜<类型>｜来自 <发送者>｜#<短id>】\n<正文>
     * 短 id 让人/agent 能精确引用"那一条"（`--reply-to <短id>`）。
     */
    function buildGroupText(group, kind, from, body, id) {
      const tag = typeof id === "string" && id.length > 0 ? `｜#${id}` : "";
      return `【群聊·${group}｜${kind}｜来自 ${from}${tag}】\n${body}`;
    }
    /** 浏览器侧生成 6 位十六进制短 id。 */
    function newGroupMessageId() {
      return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
    }
    // 与宿主/CLI 的 src/protocol.js 保持同一格式（客户端不能 import Node 模块，所以这里是副本）：
    //   【群聊·<群名>｜<类型>｜来自 <发送者>｜#<短id>】\n<正文>   —— 短 id 可选。
    const GROUP_LINE_RE = /^【群聊·([^｜]*)｜([^｜]*)｜来自 ([^｜】]*)(?:｜#([0-9a-zA-Z]{4,12}))?】\r?\n?([\s\S]*)$/;

    /** 从会话事件里抽出纯文本（只认 user/message 与 assistant/message）。 */
    function eventTextOf(event) {
      if (event === null || typeof event !== "object") return "";
      let message;
      if (event.type === "user/message") message = event.data;
      else if (event.type === "assistant/message") {
        message = event.data !== null && typeof event.data === "object" ? event.data.message : undefined;
      } else return "";
      if (message === null || typeof message !== "object" || !Array.isArray(message.content)) return "";
      const parts = [];
      for (const block of message.content) {
        if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
      return parts.join("\n").trim();
    }

    /** 会话里"不是人说的话"的已知注入形态（运行期上下文、skill 目录、后台子代理汇报）。 */
    const INJECTED_PREFIXES = ["<system-reminder>", "Current runtime context.", "Background subagent "];

    /**
     * 这条 user/message 是不是**系统/子代理注入**（而不是人打的）。
     * 用途：群聊回合中途出现一次子代理汇报时，不能把"群聊回合"的窗口关掉 ——
     * 否则该回合后半段的回复会从群聊时间线里漏掉。
     * （成员「站点成员」实测踩到过：教练派单给子代理后，这一轮的实质答复全部没进时间线。）
     */
    function isInjectedUserMessage(event) {
      const message = event.data;
      const sourceKind =
        message !== null && typeof message === "object" && message.source !== null && typeof message.source === "object"
          ? message.source.kind
          : undefined;
      if (sourceKind !== undefined && sourceKind !== "user") return true;
      const text = eventTextOf(event);
      return INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix));
    }

    /**
     * 群聊回合在**单会话视图**里的处理。
     *
     * 会话视图的节点是按回合顺序渲染的：`user` → `context`/`assistant-step`/`tool-call`… → `turn-tail`
     * （实测自 dsh-client-ui-conversation 的 `data-chat-flow-kind`）。扫一遍节点序列：
     *   · 带群聊前缀的那条 `user`（消息本体）→ **压成一行**，保留 `【群聊·…｜ask｜来自 站点成员】` 这个摘要；
     *   · 该回合其余节点（上下文注入 / 助手输出 / 工具调用 / 回合尾）→ **整段隐藏**。
     * 成员「教练成员」反馈：纯折叠会让"跨会话的约定"藏在看不见的回合里，留一行摘要就能避免。
     *
     * 只加属性（样式由注入的 CSS 负责），不碰 React 状态；关掉开关就全部还原。
     */
    /**
     * 点击群聊摘要行 = 展开 / 收起这一整轮。
     * 只加属性（CSS 负责显隐），不碰 React 状态 —— 与这套隐藏机制的整体做法一致。
     */
    function onGroupSummaryClick(event) {
      const node = event.currentTarget;
      const match = /#([0-9a-zA-Z]{4,12})】/.exec((node.textContent || "").trim());
      if (match === null) return;
      const id = match[1];
      if (openedGroupTurns.has(id)) openedGroupTurns.delete(id);
      else openedGroupTurns.add(id);
      if (typeof groupTurnRefresh === "function") groupTurnRefresh();
    }

    function hideGroupTurns(enabled, isolate = readUiPrefs().isolateGroupTurns !== false) {
      // ── 对话视图：按**正文**识别，不按 flow kind ────────────────────────────
      // 以前靠 `kind === "user"` 识别群聊消息本体，但产品现在把用户消息渲染成 `steering`，
      // 于是这段判断**从来没命中过**（功能静默失效），群聊消息就以完整的气泡形式出现，
      // 看起来跟"人自己打的"一模一样（用户实测报的"像是泄露"）。
      // 现在只看正文是否以 `【群聊·` 开头 —— 与 kind 无关，产品怎么改渲染都不影响。
      //
      // ★ 2026-09-22 起这里再往前走一步（`isolate`，默认开）：
      //   在这之前**刻意只压那一行**、不隐藏该回合其余节点（当时的理由：全藏会把"我回给人的话"
      //   一起藏掉，用户报过"看不到消息"）。但由此产生的新问题是：
      //   **成员对群聊的回复是完整显示的** ⇒ 在"用户 ↔ 该成员"的一对一会话里看起来像它在跟用户说话，
      //   把正常对话挤下去（用户实测报的"我的独立会话被污染"）。
      //   ⇒ 现在：**整段收起 + 摘要行可点展开** —— 既不再污染一对一会话，也没有"再也看不到"。
      const opened = openedGroupTurns;
      const nodes = document.querySelectorAll("[data-chat-flow-kind]");
      let currentTurnId = null;
      let inGroupTurn = false;
      for (const node of nodes) {
        const kind = node.getAttribute("data-chat-flow-kind");
        const text = (node.textContent || "").trim();
        // 回合边界：产品把用户消息渲染成 `user` 或 `steering` 都可能，两者都算"新回合开始"。
        const startsTurn = kind === "user" || kind === "steering";
        if (startsTurn) {
          inGroupTurn = enabled === true && text.startsWith("【群聊·");
          const idMatch = inGroupTurn ? /#([0-9a-zA-Z]{4,12})】/.exec(text) : null;
          currentTurnId = idMatch !== null ? idMatch[1] : null;
          if (inGroupTurn) {
            if (!node.hasAttribute(GROUPMSG_ATTR)) node.setAttribute(GROUPMSG_ATTR, "1");
            if (!node.hasAttribute(CLAMP_ATTR)) node.setAttribute(CLAMP_ATTR, "1");
            if (isolate === true) {
              if (!node.hasAttribute(GROUPTOGGLE_ATTR)) {
                node.setAttribute(GROUPTOGGLE_ATTR, "1");
                node.addEventListener("click", onGroupSummaryClick);
              }
              if (currentTurnId !== null && opened.has(currentTurnId)) node.setAttribute(GROUP_OPEN_ATTR, "1");
              else node.removeAttribute(GROUP_OPEN_ATTR);
              node.setAttribute("title", "这是工作室里别的会话投进来的消息。点击展开/收起这一整轮。");
            } else {
              if (node.hasAttribute(GROUPTOGGLE_ATTR)) node.removeAttribute(GROUPTOGGLE_ATTR);
              node.removeAttribute(GROUP_OPEN_ATTR);
            }
          } else {
            if (node.hasAttribute(GROUPMSG_ATTR)) node.removeAttribute(GROUPMSG_ATTR);
            if (node.hasAttribute(CLAMP_ATTR)) node.removeAttribute(CLAMP_ATTR);
            if (node.hasAttribute(GROUPTOGGLE_ATTR)) node.removeAttribute(GROUPTOGGLE_ATTR);
            node.removeAttribute(GROUP_OPEN_ATTR);
          }
          // 摘要行本身**永远显示**（它就是"这里发生过一次跨会话"的那一行）
          if (node.hasAttribute(GROUPTURN_ATTR)) node.removeAttribute(GROUPTURN_ATTR);
          continue;
        }
        // 非 user 节点 ⇒ 属于当前回合：整轮隔离时收起来（除非这一轮被点开过）
        const showReply = inGroupTurn && isolate === true && currentTurnId !== null && opened.has(currentTurnId);
        if (inGroupTurn && isolate === true && showReply !== true) {
          if (!node.hasAttribute(GROUPTURN_ATTR)) node.setAttribute(GROUPTURN_ATTR, "1");
        } else if (node.hasAttribute(GROUPTURN_ATTR)) {
          node.removeAttribute(GROUPTURN_ATTR);
        }
      }
      // 旧行为（isolate 关）：顺手清掉可能残留的整轮标记，确保开关一关就立刻还原
      if (isolate !== true) {
        for (const node of document.querySelectorAll(`[${GROUPTURN_ATTR}]`)) node.removeAttribute(GROUPTURN_ATTR);
      }

      // ── 轨迹视图（同一个会话的另一种渲染：表格）─────────────────────────────
      // 之前只处理了「对话」视图，用户切到「轨迹」就能看到完整的群聊消息 —— 那就是泄露点。
      // 轨迹的每一行带 `data-turn-start` / `data-turn-end`，正好用来划回合边界：
      // 从「带群聊前缀的 user 行」开始隐藏，直到该回合的 turn-end 行为止（整段）。
      let trajectoryHiding = false;
      for (const row of document.querySelectorAll("table tr")) {
        if (row.getAttribute("data-turn-start") === "true") {
          const label = row.getAttribute("aria-label") ?? row.textContent ?? "";
          trajectoryHiding = enabled === true && label.includes("【群聊·");
        }
        if (trajectoryHiding) {
          if (!row.hasAttribute(HIDDEN_ATTR)) row.setAttribute(HIDDEN_ATTR, "1");
        } else if (row.hasAttribute(HIDDEN_ATTR)) {
          row.removeAttribute(HIDDEN_ATTR);
        }
        if (row.getAttribute("data-turn-end") === "true") trajectoryHiding = false;
      }
    }

    /**
     * 把一段事件流折叠成群聊时间线。**只有群聊自身产生的消息才进群聊**：
     *   · 带群聊前缀的 user/message（面板发的、或成员 agent 用 studio_say 发的）
     *   · 紧随其后、同一回合里的 assistant/message（对方的回复）
     * 单会话自己的东西（人手动打的、运行期注入、子代理汇报、它自己干的活）一律不进群聊。
     *
     * `state` 是跨事件保留的"当前回合是否群聊回合"标记（实时路径用 Map，回填路径用局部变量）。
     */
    function foldTimelineEvent(state, sessionId, member, event, push) {
      if (event === null || typeof event !== "object") return;
      if (event.type === "turn/end") {
        state.inGroupTurn = false;
        return;
      }
      const text = eventTextOf(event);
      if (text.length === 0) return;
      const at = new Date(typeof event.time === "number" ? event.time : Date.now()).toISOString();
      if (event.type === "user/message") {
        const parsed = GROUP_LINE_RE.exec(text);
        if (parsed === null) {
          // 用了群聊标记但前缀不合法 = **静默失败**（消息被当普通用户消息收下，不进时间线也不报错）。
          if (text.startsWith("【群聊")) {
            push({
              id: `warn|${sessionId}|${String(event.time ?? "")}|${text.slice(0, 60)}`,
              at,
              sessionId,
              direction: "in",
              kind: "warn",
              author: "工作室",
              text:
                "⚠ 这条消息带了群聊标记但**前缀不合法**，所以没有被识别为群聊消息" +
                "（既不会进群聊时间线，也不会被当成群聊回合）。建议改用 bin\\say.mjs 发送，别手写前缀。\n原文开头：" +
                text.slice(0, 200),
            });
          }
          // 系统/子代理注入**不关闭**群聊窗口；只有人打的普通消息才关闭。
          if (!isInjectedUserMessage(event)) state.inGroupTurn = false;
          return;
        }
        state.inGroupTurn = true;
        push({
          id: `out|${sessionId}|${String(event.time ?? "")}|${text.slice(0, 60)}`,
          at,
          sessionId,
          direction: "out",
          kind: parsed[2],
          author: parsed[3],
          ref: parsed[4] ?? undefined,
          text: parsed[5].slice(0, MAX_TIMELINE_TEXT),
        });
        return;
      }
      if (event.type !== "assistant/message" || state.inGroupTurn !== true) return;
      push({
        id: `in|${sessionId}|${String(event.time ?? "")}|${text.slice(0, 60)}`,
        at,
        sessionId,
        direction: "in",
        kind: "chat",
        author: member.alias.length > 0 ? member.alias : shortId(member.sessionId),
        text: text.slice(0, MAX_TIMELINE_TEXT),
      });
    }

    /** 对一段事件数组做折叠（历史回填用）。 */
    function foldGroupTimeline(sessionId, member, events) {
      const state = { inGroupTurn: false };
      const out = [];
      for (const event of events) foldTimelineEvent(state, sessionId, member, event, (entry) => out.push(entry));
      return out;
    }

    function ChatTab(props) {
      const { store, state, connection, useSessionsHook } = props;
      const list = useSessionsHook((snapshot) => snapshot);
      const data = state.data;
      const members = data === null ? [] : data.members;
      /**
       * **可派发的成员** = 成员表里排除退役记录。
       *
       * 为什么必须分两份：退役记录要继续留在成员台里（历史、寻址、审计都要用），
       * 但它**不能被选中当投递目标** —— 之前派发选项里残留退役会话，选中后消息会投进
       * 一个已经没人读的会话，而且从界面上看"发送成功"。这与 CLI 侧 `@all` 跳过退役成员
       * 是同一条口径（`bin/say.mjs`），这里只是把这个口径补到面板的派发选项上。
       */
      const dispatchMembers = members.filter((member) => !isRetiredMember(member));
      const retiredCount = members.length - dispatchMembers.length;
      const group = data === null ? undefined : data.groups.find((entry) => entry.groupId === data.activeGroupId);
      const groupName = group !== undefined ? group.name : "我的工作室";

      const [historyEntries, setHistoryEntries] = React.useState([]);
      const [target, setTarget] = React.useState("");
      const [draft, setDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(undefined);
      /**
       * 未读 / 滚动定位。
       * 早期版本挂载时 scrollTop 停在 0，而列表是升序的 —— 刷新后**看到的是最旧的那几条**，
       * 用户要自己滚到底。现在：挂载时定位到「第一条未读」（没有未读就定位到最新），
       * 并且已经贴着底部时新消息会自动跟随；不贴底时只涨未读角标。
       */
      const scrollRef = React.useRef(null);
      const [unread, setUnread] = React.useState(0);
      const readMarkRef = React.useRef(readTimelineMark());

      /** 单会话视图里是否收起群聊回合（与成员台同源的偏好开关）。 */
      const togglePref = (key) => {
        const next = !(store.get()[key] !== false);
        store.set({ [key]: next });
        writeUiPrefs({ ...store.get(), [key]: next });
      };

      const targetSession = dispatchMembers.some((entry) => entry.sessionId === target)
        ? target
        : dispatchMembers[0] !== undefined
          ? dispatchMembers[0].sessionId
          : "";

      // 时间线由插件在信封 tap 里记录（见 apply），这里只是读者；合并只读载入的历史。
      // 两边都已经只保留"群聊自身产生的消息"，所以这里不需要再过滤。
      const merged = React.useMemo(() => {
        const seen = new Set();
        const all = [];
        for (const message of [...state.timeline, ...historyEntries]) {
          const key = `${message.sessionId}|${message.at}|${String(message.text).slice(0, 40)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(message);
        }
        all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        return all.slice(-MAX_TIMELINE);
      }, [state.timeline, historyEntries]);

      const api = connection !== undefined ? connection.api : undefined;
      const canSend = api !== undefined && api.sessions !== undefined && typeof api.sessions.prompt === "function";

      // 两段式回执的状态点（纯显示）：📨 已送达 → 📝 已回执 → ✅ 已交付 / 🚫 已推掉。
      const receipts = React.useMemo(() => buildReceiptMap(merged, members), [merged, members]);
      // 观测式进度：定期刷新（工具调用不进 store，避免高频重绘）。
      const [activityTick, setActivityTick] = React.useState(0);
      React.useEffect(() => {
        const timer = window.setInterval(() => setActivityTick((value) => value + 1), 1500);
        return () => window.clearInterval(timer);
      }, []);
      const activityOf = (sessionId) => describeActivity(activityBySession.get(sessionId), Date.now(), ACTIVITY_WINDOW_MS);
      void activityTick;
      // 卡片两侧配色 + 两端标签：左 = 发起者，右 = 接收者。
      const flows = React.useMemo(() => buildFlowMap(merged, members), [merged, members]);
      /**
       * 广播合并（方案 A）：同一条广播发给了 N 位成员 ⇒ 时间线里本会出现 N 张几乎相同的卡片。
       * 这里按**正文首行的广播标记**把它们归组：只在时间线上保留**第一份**，
       * 其余副本收起来（卡片上标出"共 N 份"）。标记写在正文首行而不是消息头，是因为
       * 消息头格式被成员侧 CLI 的正则严格解析，加第 5 段会让它解析失败。
       */
      const broadcasts = React.useMemo(() => {
        const byId = new Map();
        const idOfItem = new Map();
        for (const message of merged) {
          if (message.direction !== "out") continue;
          const broadcastId = broadcastMarkerOf(message.text);
          if (broadcastId === undefined) continue;
          idOfItem.set(message.id, broadcastId);
          const list = byId.get(broadcastId) ?? [];
          list.push(message.id);
          byId.set(broadcastId, list);
        }
        return { byId, idOfItem };
      }, [merged]);
      const showReceipts = state.showReceipts !== false;


      /** 贴底判定（40px 容差，避免平滑滚动/取整误差）。 */
      const isNearBottom = () => {
        const el = scrollRef.current;
        if (el === null) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      };
      const scrollToBottom = () => {
        const el = scrollRef.current;
        if (el !== null) el.scrollTop = el.scrollHeight;
      };
      /** 把"此刻最后一条"记为已读。 */
      const markRead = (list) => {
        const last = list !== undefined && list.length > 0 ? list[list.length - 1].at : undefined;
        if (last === undefined) return;
        readMarkRef.current = last;
        writeTimelineMark(last);
        setUnread(0);
      };
      /** 未读条数（严格晚于已读时间点）。 */
      const countUnread = (list, mark) =>
        mark === undefined ? 0 : list.filter((message) => String(message.at) > String(mark)).length;

      /**
       * 定位与未读。**关键点**：effect 是在新内容**已经布局之后**才跑的，
       * 所以"scroller 还是空的 ⇒ 一定贴底"这个假设不成立（曾经因此既没滚动也没记已读）。
       * 现在用一个"首次拿到内容"的标志来驱动：首次一律定位（第一条未读，或最新），之后才按贴底跟随。
       */
      /** 最新一次渲染的时间线（滚动/卸载时要用，避免闭包拿到旧数组）。 */
      const mergedRef = React.useRef(merged);
      mergedRef.current = merged;

      /**
       * 「滚到底 = 读过了」。
       *
       * 旧实现**只在"有新内容且贴底"时**才推进已读位置，于是最常见的那条路径
       * ——「打开面板 → 滚到底把新的读完 → 关掉」——**根本不会推进标记**：
       * 因为滚动不改变 `merged`，effect 不重跑。结果下次打开时 `mark` 还是很久以前的，
       * 于是"定位到第一条未读"跳到的是一条**早就看过的旧消息**（用户实测报的"跳到非常顶部"）。
       * 现在补两个推进点：滚动到贴底、以及关闭面板（卸载）时若贴底。
       */
      React.useEffect(() => {
        const el = scrollRef.current;
        if (el === null) return undefined;
        const onScroll = () => {
          if (isNearBottom()) markRead(mergedRef.current);
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
      }, [merged.length > 0]);
      React.useEffect(
        () => () => {
          const el = scrollRef.current;
          if (el !== null && isNearBottom()) markRead(mergedRef.current);
        },
        [],
      );

      const positionedRef = React.useRef(false);
      /** 首次定位的尝试次数：DOM 还没渲染出那一条时允许重试，重试完再退回贴底（避免永久卡在顶部）。 */
      const positionTryRef = React.useRef(0);
      React.useEffect(() => {
        if (merged.length === 0) return;
        const el = scrollRef.current;
        const mark = readMarkRef.current;

        if (!positionedRef.current) {
          const firstUnread = mark === undefined ? undefined : merged.find((message) => String(message.at) > String(mark));
          const node =
            firstUnread !== undefined && el !== null
              ? el.querySelector(`[data-dsh-studio-msg="${CSS.escape(firstUnread.id)}"]`)
              : null;
          if (node !== null && el !== null) {
            positionedRef.current = true;
            // ★ 必须用**视口坐标差**来滚，不能用 `node.offsetTop - el.offsetTop`：
            //   `offsetTop` 是相对**最近的定位祖先（offsetParent）**的，两个节点不共享同一个
            //   offsetParent 时这个差值毫无意义 —— 表现就是"跳到了错误的位置"（用户报的
            //   "最近未读消息没有正确实现"）。矩形差与 offsetParent 无关，永远成立。
            const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
            el.scrollTop = Math.max(0, el.scrollTop + delta - 12);
            setUnread(countUnread(merged, mark));
            return;
          }
          // 首次内容里还没渲染出那一条（历史回填是异步的）：重试几次，别急着 markRead。
          positionTryRef.current += 1;
          if (firstUnread !== undefined && positionTryRef.current <= 3) return;
          positionedRef.current = true;
          scrollToBottom();
          markRead(merged);
          return;
        }

        // 之后：贴底就跟随并标记已读，不贴底只涨未读角标。
        if (isNearBottom()) {
          scrollToBottom();
          markRead(merged);
        } else {
          setUnread(countUnread(merged, readMarkRef.current));
        }
      }, [merged]);

      /** S4 手动传话：只用 mode:"queue"（宿主侧 = agent.followup，排队不抢占进行中的 turn）。 */
      /** 多选派发（方案 A）：选中的成员集合；多选模式下点 chip 是勾选而不是切换目标。 */
      const [multiMode, setMultiMode] = React.useState(false);
      const [picked, setPicked] = React.useState([]);

      const togglePicked = (sessionId) => {
        setPicked((previous) =>
          previous.includes(sessionId) ? previous.filter((id) => id !== sessionId) : [...previous, sessionId],
        );
      };

      /**
       * 广播标记：**放在正文首行**，不改消息头（消息头格式被成员侧的 CLI 正则严格解析，
       * 加第 5 段会让它解析失败）。解析器在模块作用域：`broadcastMarkerOf`。
       */
      const send = async () => {
        const body = draft.trim();
        if (body.length === 0) return;
        if (!canSend) {
          setNotice("connection 服务不可用，无法投递消息。");
          return;
        }
        // 多选模式且勾了 ≥1 位 → 批量派发；否则走原来的单发。
        // ⚠️ 只从 `dispatchMembers` 里取目标：退役记录即使残留在线程状态里也不得被投递。
        const broadcastTargets =
          multiMode === true
            ? dispatchMembers.filter((entry) => picked.includes(entry.sessionId))
            : dispatchMembers.filter((entry) => entry.sessionId === targetSession);
        if (broadcastTargets.length === 0) {
          setNotice(
            multiMode === true
              ? "先在成员 chip 上勾选至少一位成员。"
              : retiredCount > 0 && members.length > 0
                ? "没有可派发的成员：退役记录不能作为投递目标（它们在成员台里仅作历史保留）。"
                : "先在成员台里提升至少一个成员。",
          );
          return;
        }
        const isBroadcast = broadcastTargets.length > 1;
        const broadcastId = isBroadcast ? newGroupMessageId() : undefined;
        const wireBody = isBroadcast ? `〖广播 #${broadcastId}〗\n${body}` : body;
        setBusy(true);
        setNotice(undefined);
        try {
          const results = [];
          for (const member of broadcastTargets) {
            const text = buildGroupText(groupName, "say", "我", wireBody, newGroupMessageId());
            try {
              const { result } = await api.sessions.prompt({
                sessionId: member.sessionId,
                mode: "queue",
                content: [{ type: "text", text }],
              });
              if (result === undefined || result.ok !== true) {
                const detail =
                  result !== undefined && result.error !== undefined
                    ? `${result.error.message}（${result.error.code}）`
                    : "投递被拒绝";
                results.push({ name: member.alias.length > 0 ? member.alias : shortId(member.sessionId), ok: false, detail });
              } else {
                results.push({ name: member.alias.length > 0 ? member.alias : shortId(member.sessionId), ok: true, detail: "已入队" });
              }
            } catch (error) {
              results.push({
                name: member.alias.length > 0 ? member.alias : shortId(member.sessionId),
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          }
          const okCount = results.filter((item) => item.ok).length;
          setDraft("");
          setNotice(
            isBroadcast
              ? `已广播 #${broadcastId} 给 ${okCount}/${results.length} 位成员：` +
                results.map((item) => `${item.ok ? "✅" : "❌"}${item.name}`).join(" ") +
                "（queue 排队；时间线上会合并成一张广播卡）"
              : `已投递给「${results[0].name}」（${results[0].detail}）——queue 排队，不会打断它进行中的工作。它的回复会自动出现在时间线上。`,
          );
        } catch (error) {
          setNotice(`发送失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      /** 只读回填：用产品自己的分页 history RPC 读最近 50 条消息，不碰任何写路径。 */
      const loadHistory = async () => {
        const member = members.find((entry) => entry.sessionId === targetSession);
        if (member === undefined || !canSend) {
          setNotice("需要先有成员，且 connection 服务可用。");
          return;
        }
        setBusy(true);
        setNotice(undefined);
        try {
          const { result } = await api.sessions.history({ sessionId: member.sessionId, maxMessages: 50 });
          if (result === undefined || result.ok !== true) throw new Error("history 读取被拒绝");
          const rows = Array.isArray(result.value.events) ? result.value.events : [];
          const loaded = foldGroupTimeline(
            member.sessionId,
            member,
            rows.map((row) => (row !== null && typeof row === "object" ? row.event : undefined)),
          );
          setHistoryEntries((previous) => {
            const byKey = new Map(previous.map((item) => [item.id, item]));
            for (const item of loaded) byKey.set(item.id, item);
            return [...byKey.values()];
          });
          // 回填的内容也并入**持久时间线**：否则刷新一次就没了，而"未读"必须有耐久的底账才有意义。
          if (loaded.length > 0) {
            store.set((prev) => {
              const byId = new Map(prev.timeline.map((item) => [item.id, item]));
              for (const item of loaded) if (!byId.has(item.id)) byId.set(item.id, item);
              const next = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
              return { ...prev, timeline: next.length > MAX_TIMELINE ? next.slice(next.length - MAX_TIMELINE) : next };
            });
            scheduleTimelineSave(() => store.get().timeline);
          }
          setNotice(
            `已从「${member.alias.length > 0 ? member.alias : shortId(member.sessionId)}」读了最近 ${loaded.length} 条**群聊**消息（只读、已并入群聊记录；该会话自己的对话不在群聊里）。`,
          );
        } catch (error) {
          setNotice(`读历史失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setBusy(false);
        }
      };

      const clearTimeline = () => {
        clearTimelineStorage();
        store.set({ timeline: [] });
        setHistoryEntries([]);
        setNotice("已清空本地群时间线（只清工作室的记录，不影响任何会话的历史）。");
      };

      if (members.length === 0) {
        return React.createElement(
          "div",
          { style: styles.section },
          React.createElement("div", { style: styles.sectionTitle }, "群聊"),
          React.createElement(
            "div",
            { style: styles.small },
            "还没有成员。先在「成员台」里把一个会话提升为成员，群聊就有对象了。",
          ),
        );
      }

      const targetMember = members.find((entry) => entry.sessionId === targetSession);
      const summaryFor = (sessionId) =>
        list !== undefined && list.byId !== undefined ? list.byId[sessionId] : undefined;

      // 投递目标选择 + 输入框都放在面板**下方同一块固定区**里，中间不再被消息区隔开。
      const memberChips = React.createElement(
        "div",
        { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
        // 「多选派发」开关（方案 A）：打开后点 chip 是**勾选**，发送按钮变成批量广播。
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              setMultiMode((previous) => !previous);
              setPicked([]);
            },
            title: "打开后：点成员 chip 是勾选，发送按钮会把同一条正文广播给所有勾选的成员（时间线合并成一张卡）",
            style: {
              padding: "3px 8px",
              borderRadius: 12,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              border: `1px solid ${multiMode ? C.warn : C.border}`,
              background: multiMode ? C.bg : "transparent",
              color: multiMode ? C.warn : C.label3,
            },
          },
          multiMode === true ? `📣 多选中（${picked.length}）` : "📣 多选派发",
        ),
        dispatchMembers.map((member) => {
          const summary = summaryFor(member.sessionId);
          const running = summary !== undefined && summary.running === true;
          const active = member.sessionId === targetSession;
          const checked = picked.includes(member.sessionId);
          const highlighted = multiMode === true ? checked : active;
          return React.createElement(
            "button",
            {
              key: member.sessionId,
              type: "button",
              onClick: () => (multiMode === true ? togglePicked(member.sessionId) : setTarget(member.sessionId)),
              title:
                multiMode === true
                  ? `勾选/取消：${member.alias.length > 0 ? member.alias : shortId(member.sessionId)}`
                  : `选中投递目标：${member.alias.length > 0 ? member.alias : shortId(member.sessionId)}`,
              style: {
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 8px",
                borderRadius: 12,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
                border: `1px solid ${highlighted ? C.label2 : C.border}`,
                background: highlighted ? C.bg : "transparent",
                color: highlighted ? C.label : C.label3,
              },
            },
            multiMode === true
              ? React.createElement("span", { style: { fontVariant: "tabular-nums" } }, checked ? "☑" : "☐")
              : null,
            React.createElement("span", { style: styles.dot(COLOR_OF[member.color] ?? C.label3) }),
            member.alias.length > 0 ? member.alias : shortId(member.sessionId),
            running ? React.createElement("span", { style: { color: C.ok } }, "●") : null,
          );
        }),
      );

      return React.createElement(
        "div",
        { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
        notice !== undefined ? React.createElement("div", { style: styles.banner }, notice) : null,
        React.createElement(
          "div",
          { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 0" }, ref: scrollRef },
          React.createElement(
            "div",
            { style: styles.section },
            React.createElement(
              "div",
              { style: styles.sectionTitle },
              `群「${groupName}」· ${dispatchMembers.length} 位可派发成员` +
                (retiredCount > 0 ? `（另有 ${retiredCount} 条退役记录，仅保留历史、不可派发）` : ""),
            ),
            React.createElement(
              "div",
              { style: { ...styles.small, marginBottom: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
              React.createElement(
                "span",
                null,
                `本次记录 ${state.timeline.length} 条（存 localStorage，上限 ${MAX_TIMELINE}，刷新不丢）` +
                  (historyEntries.length > 0 ? ` · 已只读载入历史 ${historyEntries.length} 条` : "") +
                  " · 只有群聊产生的消息",
              ),
              unread > 0
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      onClick: () => {
                        scrollToBottom();
                        markRead(merged);
                      },
                      style: {
                        padding: "1px 8px",
                        borderRadius: 10,
                        border: `1px solid ${C.border}`,
                        background: C.bg,
                        color: C.warn,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        fontSize: 11,
                        // 粘在滚动区顶部：否则它会被列表滚走，用户"感觉不到角标存在"（实测反馈）。
                        position: "sticky",
                        top: 0,
                        zIndex: 5,
                        alignSelf: "flex-start",
                      },
                    },
                    `${unread} 条未读 · 跳到最新`,
                  )
                : null,
            ),
          ),
          React.createElement(
            "div",
            { style: styles.section },
            merged.length === 0
              ? React.createElement(
                  "div",
                  { style: styles.small },
                  "时间线还是空的。在下面发一条消息，或点「读该成员最近 50 条」看看它那边已经有什么。",
                )
              : merged.map((message) => {
                  const out = message.direction === "out";
                  const isWarn = message.kind === "warn";
                  const member = members.find((entry) => entry.sessionId === message.sessionId);
                  const flow = flows.get(message.id);
                  // 「自己指向自己」：该会话自己的输出（`in`），或两端标签相同的条目。
                  // 用户要求把这类消息底色改成淡灰，好和"从别的会话投进来的消息"区分开。
                  const isSelfToSelf = !isWarn && (out === false || (flow !== undefined && flow.from === flow.to));
                  // 广播合并：同一广播的**后续副本不渲染**（时间线只占一张卡）。
                  const broadcastId = broadcasts.idOfItem.get(message.id);
                  const copies = broadcastId !== undefined ? broadcasts.byId.get(broadcastId) : undefined;
                  if (copies !== undefined && copies[0] !== message.id) return null;
                  const fromLabel = flow !== undefined ? flow.from : message.author;
                  const toLabel =
                    flow !== undefined
                      ? flow.to
                      : member !== undefined
                        ? member.alias.length > 0
                          ? member.alias
                          : shortId(member.sessionId)
                        : shortId(message.sessionId);
                  return React.createElement(
                    "div",
                    {
                      key: message.id,
                      "data-dsh-studio-msg": message.id,
                      style: {
                        ...styles.card,
                        // 左 = 发起者颜色，右 = 接收者颜色（warn 条目保持红色左边、中性右边）。
                        borderLeft: `3px solid ${isWarn ? C.error : flow !== undefined ? flow.fromColor : C.label3}`,
                        borderRight: `3px solid ${isWarn ? C.borderSoft : flow !== undefined ? flow.toColor : C.borderSoft}`,
                        // 用户要求：**自己指向自己的消息**（就是"该会话自己的输出/思考"）底色改**淡灰**，
                        // 与"投进来的群聊消息"（有 📨 前缀 + 左侧竖条）在视觉上分开。
                        ...(isSelfToSelf ? { background: "rgba(125,135,150,.13)" } : {}),
                        ...(isWarn ? { background: "rgba(229,83,75,.08)" } : {}),
                      },
                    },
                    React.createElement(
                      "div",
                      { style: { ...styles.small, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                      // 两端名字各用自己那一侧的颜色，和卡片左右边框一致（一眼看出「谁 → 谁」）。
                      React.createElement(
                        "span",
                        { style: { color: flow !== undefined ? flow.fromColor : C.label3, fontWeight: 600 } },
                        fromLabel,
                      ),
                      React.createElement("span", { style: { color: C.label3 } }, "→"),
                      React.createElement(
                        "span",
                        { style: { color: flow !== undefined ? flow.toColor : C.label2, fontWeight: 600 } },
                        toLabel,
                      ),
                      message.kind !== "chat" ? React.createElement("span", { style: styles.chip }, message.kind) : null,
                      // 广播卡：标出"这一条其实是 N 份"，其余副本已被收起（见上方的 broadcasts 归组）。
                      broadcastId !== undefined && copies !== undefined
                        ? React.createElement(
                            "span",
                            {
                              style: { ...styles.chip, color: C.warn },
                              title: `同一条广播发给了 ${copies.length} 位成员；时间线上只保留这一张卡，其余 ${copies.length - 1} 份已收起。`,
                            },
                            `📣 广播 #${broadcastId} · ${copies.length} 份`,
                          )
                        : null,
                      // 两段式回执状态点：只画在"投递出去"的消息上，纯显示、不发消息。
                      showReceipts && receipts.get(message.id) !== undefined
                        ? (() => {
                            const style = RECEIPT_STYLE[receipts.get(message.id)];
                            return React.createElement(
                              "span",
                              { style: { ...styles.chip, color: style.color }, title: style.title },
                              style.text,
                            );
                          })()
                        : null,
                      // 短 id：人/agent 引用"那一条"时用它（--reply-to <短id>）
                      message.ref !== undefined
                        ? React.createElement("span", { style: styles.chip, cursor: "pointer" , title: "点击复制短 id（可用于 --reply-to）" }, `#${message.ref}`)
                        : null,
                      React.createElement("span", { style: { opacity: 0.7 } }, clockOf(message.at)),
                    ),
                    React.createElement(
                      "div",
                      { style: { whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 3, maxHeight: 160, overflowY: "auto" } },
                      String(message.text).slice(0, 2000),
                    ),
                    // 观测式"执行中"：这条 ask 还没有回执/交付，但收件人会话里正在动工具 →
                    // 直接把事实摆出来（委托方不必再去轮询文件系统 / 猜它是不是卡住了）。
                    (() => {
                      if (message.direction !== "out" || message.kind !== "ask") return null;
                      const state = receipts.get(message.id);
                      if (state === "delivered" || state === "acked" || state === "declined") return null;
                      const activity = activityOf(message.sessionId);
                      if (activity === undefined) return null;
                      return React.createElement(
                        "div",
                        {
                          style: { ...styles.small, marginTop: 4, color: C.warn },
                          title: "来自工作室对该会话事件流的观测（真实工具调用），不是对方自述，也不是推测",
                        },
                        `⏳ 执行中：${toLabel} 最近 ${activity}`,
                      );
                    })(),
                  );
                }),
          ),
        ),
        React.createElement(
          "div",
          { style: styles.dockBottom },
          memberChips,
          React.createElement(
            "div",
            { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } },
            React.createElement(Button, { icon: Icon.Link, disabled: busy, onClick: () => void loadHistory() }, "读该成员最近 50 条"),
            React.createElement(
              Button,
              {
                disabled: busy,
                title: "群聊产生的回合在单会话视图里整段收起。只影响显示：记忆仍是同一份会话日志。",
                onClick: () => togglePref("hideInSession"),
              },
              state.hideInSession !== false ? "单会话里隐藏群聊：开" : "单会话里隐藏群聊：关",
            ),
            React.createElement(
              Button,
              {
                disabled: busy,
                title:
                  "★ 群聊整轮隔离：群聊产生的那一轮在单会话视图里**整段收起**（含成员对群聊的回复），" +
                  "只留一行摘要；想内容就点那行摘要展开。\n" +
                  "为什么要有它：成员对群聊的回复原本是完整显示的，于是在「你 ↔ 该成员」的一对一会话里，" +
                  "看起来就像它在跟你说话，把你的正常对话挤下去。\n" +
                  "只影响显示：记忆仍是同一份会话日志，成员照常参与群聊，群聊内容也始终能在面板的「群聊」页完整看到。",
                onClick: () => togglePref("isolateGroupTurns"),
              },
              state.isolateGroupTurns !== false ? "群聊整轮隔离（含它的回复）：开" : "群聊整轮隔离（含它的回复）：关",
            ),
            React.createElement(
              Button,
              {
                disabled: busy,
                title:
                  "回执协议是两段式的：① 接受状态 = 📨 已送达（消息投进对方信箱即成立，由发送侧记录，" +
                  "不发任何消息，这里只看到一个状态点）；② 正式回执 = 对方 agent 自己在「读完任务、动手之前」" +
                  "发的 ack/decline（say.mjs --ack/--decline），那是它自己的话，正常显示成卡片。" +
                  "关掉这个开关只是不画状态点，不影响任何消息。",
                onClick: () => togglePref("showReceipts"),
              },
              state.showReceipts !== false ? "显示回执状态点：开" : "显示回执状态点：关",
            ),
            React.createElement(Button, { icon: Icon.Trash, disabled: busy, onClick: clearTimeline }, "清空"),
          ),
          React.createElement("textarea", {
            style: { ...styles.input, minHeight: 48, resize: "vertical" },
            placeholder: "要传的话…（queue 排队，不打断对端进行中的工作）",
            value: draft,
            onChange: (event) => setDraft(event.target.value),
          }),
          React.createElement(
            "div",
            { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            React.createElement(
              Button,
              { icon: Icon.Plus, disabled: busy || draft.trim().length === 0 || !canSend, onClick: () => void send() },
              `发送给「${targetMember !== undefined ? (targetMember.alias.length > 0 ? targetMember.alias : shortId(targetMember.sessionId)) : "?"}」`,
            ),
            React.createElement(
              "span",
              { style: styles.small },
              canSend ? "只写一条 user 消息到对端日志" : "connection 服务不可用",
            ),
          ),
        ),
      );
    }

    function Diagnostics(props) {
      const data = props.data;
      // 界面注入的自检：样式表为空或注入报错时，必须在面板上看得见（否则会静默失效）。
      const status = window[STATUS_KEY];
      const decorateError = status !== undefined && typeof status.decorateError === "function" ? status.decorateError() : undefined;
      const styleLength = status !== undefined && typeof status.styleTagLength === "function" ? status.styleTagLength() : 0;
      const lock = data !== null && data !== undefined ? data.lock : undefined;
      const last = lock !== undefined && lock.intercepts.length > 0 ? lock.intercepts[lock.intercepts.length - 1] : undefined;
      return React.createElement(
        "div",
        { style: styles.footer },
        React.createElement("div", null, `数据文件：${data !== null && data !== undefined ? data.file : "（未连接）"}`),
        React.createElement(
          "div",
          null,
          lock === undefined
            ? "锁定位：未知"
            : lock.installed
              ? "锁定位：已安装"
              : `锁定位：不可用 —— ${String(lock.reason)}`,
        ),
        lock !== undefined && lock.intercepts.length > 0
          ? React.createElement(
              "div",
              { style: { color: C.warn } },
              `已拦截归档 ${lock.intercepts.length} 次` + (last !== undefined ? `；最近：${String(last.label)}` : ""),
            )
          : null,
        data !== null && data !== undefined && data.loadError !== undefined && data.loadError !== null
          ? React.createElement("div", { style: { color: C.warn } }, `数据文件读取警告：${String(data.loadError)}`)
          : null,
        React.createElement(
          "div",
          { style: { color: decorateError !== undefined || styleLength === 0 ? C.error : C.label3 } },
          `界面注入：样式表 ${styleLength} 字符` + (decorateError !== undefined ? ` · 最近失败：${decorateError.message}` : ""),
        ),
      );
    }

    function Drawer(props) {
      const { store, workspacesService, connection, useSessionsHook, useWorkspacesHook } = props;
      const state = useStore(store);
      /** 拖动右边框时的临时态（拖动中不写 prefs，松手才写，避免每帧一次 localStorage）。 */
      const dragRef = React.useRef(undefined);
      const [dragging, setDragging] = React.useState(false);
      /**
       * 拖动右边框改宽度（用户要求："视图区太窄又拖不动"）。
       * 实现要点：
       *   · 用 **pointer capture** —— 拖动时指针移出手柄也继续跟手，松手自动释放；
       *   · 拖动中直接改 CSS 变量（不经过 store，避免每帧触发整轮重绘）；
       *   · **松手才落盘**（写 prefs），双击手柄 = 恢复自动宽度；
       *   · 上限仍由 decorateSidebar 守着"会话列保底 DOCK_CONVERSATION_MIN"，拖不出"盖住会话"。
       */
      const onHandleDown = (event) => {
        event.preventDefault();
        const root = document.documentElement;
        const current = Number.parseFloat(root.style.getPropertyValue("--dsh-studio-dock-width")) || DOCK_WIDTH_IDEAL;
        dragRef.current = { startX: event.clientX, startWidth: current };
        setDragging(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* 拿不到 capture 也能凑合拖（鼠标在窗口内时） */
        }
      };
      const onHandleMove = (event) => {
        const drag = dragRef.current;
        if (drag === undefined) return;
        const next = Math.max(DOCK_WIDTH_MIN, Math.round(drag.startWidth + (event.clientX - drag.startX)));
        document.documentElement.style.setProperty("--dsh-studio-dock-width", `${next}px`);
      };
      const onHandleUp = (event) => {
        const drag = dragRef.current;
        if (drag === undefined) return;
        dragRef.current = undefined;
        setDragging(false);
        const applied = Math.round(
          Number.parseFloat(document.documentElement.style.getPropertyValue("--dsh-studio-dock-width")) || drag.startWidth,
        );
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* 已释放 */
        }
        store.set({ dockWidth: applied });
        writeUiPrefs({ ...store.get(), dockWidth: applied });
      };
      /** 双击手柄 = 回到自动宽度（0 = 自动）。 */
      const onHandleReset = () => {
        store.set({ dockWidth: 0 });
        writeUiPrefs({ ...store.get(), dockWidth: 0 });
      };

      return React.createElement(
        "aside",
        { style: styles.drawer, "data-dsh-studio": "drawer" },
        // 右边框上的拖动条：拖它改宽度（双击 = 恢复自动）。
        React.createElement("div", {
          "data-dsh-studio-resizer": "1",
          title: "拖动改变宽度 · 双击恢复自动",
          onPointerDown: onHandleDown,
          onPointerMove: onHandleMove,
          onPointerUp: onHandleUp,
          onPointerCancel: onHandleUp,
          onDoubleClick: onHandleReset,
          style: {
            position: "absolute",
            top: 0,
            bottom: 0,
            right: -3,
            width: 6,
            cursor: "col-resize",
            zIndex: 2,
            background: dragging ? "var(--dsw-alias-label-tertiary)" : "transparent",
            touchAction: "none",
          },
        }),
        React.createElement(
          "div",
          { style: styles.header },
          React.createElement(
            "div",
            { style: styles.title },
            Icon.Sparkle !== undefined ? React.createElement(Icon.Sparkle, { size: 16 }) : null,
            "dsh工作室",
          ),
          React.createElement(Button, { icon: Icon.Refresh, title: "重新读取宿主状态", onClick: () => void props.onRefresh() }),
          React.createElement(Button, { icon: Icon.Close, title: "收起面板", onClick: () => props.onClose() }),
        ),
        state.error !== null && state.error !== undefined
          ? React.createElement("div", { style: { ...styles.banner, color: C.error } }, String(state.error))
          : null,
        React.createElement(
          "div",
          { style: styles.tabs },
          React.createElement(
            "button",
            {
              type: "button",
              style: styles.tab(state.tab === "members"),
              onClick: () => props.onTab("members"),
            },
            "成员台",
          ),
          React.createElement(
            "button",
            { type: "button", style: styles.tab(state.tab === "chat"), onClick: () => props.onTab("chat") },
            "群聊",
          ),
        ),
        React.createElement(
          "div",
          { style: styles.body },
          state.data === null
            ? React.createElement("div", { style: { ...styles.small, padding: "10px 12px" } }, "正在读取工作室数据…")
            : state.tab === "members"
              ? React.createElement("div", { style: styles.scroller }, React.createElement(MembersTab, {
                  store,
                  state,
                  workspacesService,
                  useSessionsHook,
                  useWorkspacesHook,
                }))
              : React.createElement(ChatTab, { store, state, connection, useSessionsHook }),
        ),
        React.createElement(Diagnostics, { data: state.data }),
      );
    }

    function Launcher(props) {
      return React.createElement(
        "button",
        {
          type: "button",
          style: styles.launcher,
          title: "打开 dsh工作室",
          onClick: () => props.onOpen(),
        },
        Icon.Sparkle !== undefined ? React.createElement(Icon.Sparkle, { size: 14 }) : null,
        "工作室",
      );
    }

    /** shell.overlay 的唯一条目：抽屉 / 把手二选一，外加一次性提示气泡。 */
    /**
     * 面板的错误边界（React 类组件，`getDerivedStateFromError`）。
     *
     * 背景：产品把 `shell.overlay` 槽位的渲染异常吞掉，只留一个空的 `data-slot-error` 容器 ——
     * 表现是"工作室面板和呼出按钮全都不见了"，用户和我都只能靠刷新猜。
     * 有了它，出错时面板会**自己把错误原文画出来**，而不是消失。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: undefined };
      }

      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }

      componentDidCatch(error, info) {
        console.warn(PREFIX, "panel render crashed (kept visible by boundary)", error, info);
      }

      render() {
        const error = this.state.error;
        if (error === undefined) return this.props.children;
        return React.createElement(
          "div",
          {
            "data-dsh-studio-dock": "error",
            style: {
              position: "fixed",
              left: "var(--dsh-studio-dock-left, 280px)",
              top: 0,
              width: "min(420px, 60vw)",
              maxHeight: "60vh",
              overflowY: "auto",
              zIndex: 60,
              padding: "10px 12px",
              borderRadius: 8,
              border: `1px solid ${C.error}`,
              background: C.bg,
              color: C.label,
              fontFamily: "inherit",
              fontSize: 12,
            },
          },
          React.createElement("div", { style: { fontWeight: 600, color: C.error } }, "⚠️ dsh工作室：面板渲染出错（已拦下，没让它静默消失）"),
          React.createElement("div", { style: { marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" } }, String(error.message).slice(0, 1200)),
          React.createElement(
            "div",
            { style: { ...styles.small, marginTop: 6 } },
            "完整堆栈在浏览器控制台（[dsh-studio] panel render crashed）。修好后刷新页面即可。",
          ),
        );
      }
    }

    function StudioOverlay(props) {
      const { store, workspacesService, connection } = props;
      const state = useStore(store);
      React.useEffect(() => {
        if (state.notice === undefined || state.notice === null) return undefined;
        const timer = window.setTimeout(() => store.set({ notice: undefined }), 8000);
        return () => window.clearTimeout(timer);
      }, [state.notice]);

      React.useEffect(() => {
        const root = document.documentElement;
        if (state.open) root.setAttribute(DOCK_ATTR, "open");
        else root.removeAttribute(DOCK_ATTR);
        return () => root.removeAttribute(DOCK_ATTR);
      }, [state.open]);

      const onOpen = () => {
        store.set({ open: true });
        writeUiPrefs({ ...store.get(), open: true });
        void refresh(store);
      };
      const onClose = () => {
        store.set({ open: false });
        writeUiPrefs({ ...store.get(), open: false });
      };
      const onTab = (tab) => {
        store.set({ tab });
        writeUiPrefs({ ...store.get(), tab });
      };

      const bubble =
        state.notice === undefined || state.notice === null
          ? null
          : React.createElement(
              "div",
              {
                style: {
                  ...styles.banner,
                  position: "absolute",
                  left: state.open ? 396 : 44,
                  top: state.open ? 12 : "50%",
                  transform: state.open ? undefined : "translateY(-50%)",
                  maxWidth: 340,
                  background: C.bg,
                  boxShadow: "var(--dsw-shadow-lv3)",
                  pointerEvents: "auto",
                },
              },
              String(state.notice),
            );

      const body = state.open
        ? React.createElement(Drawer, {
            store,
            workspacesService,
            connection,
            useSessionsHook: asHook(props.useSessions),
            useWorkspacesHook: asHook(props.useWorkspaces),
            onRefresh: () => void refresh(store),
            onClose,
            onTab,
          })
        : React.createElement(Launcher, { onOpen });

      return React.createElement(React.Fragment, null, body, bubble);
    }

    /** 槽位标准 props 里的 hook 可能缺席：缺席时退化为返回 undefined 的普通函数（调用序稳定）。 */
    function asHook(candidate) {
      return typeof candidate === "function" ? candidate : () => undefined;
    }

    async function refresh(store) {
      try {
        const value = await callHost("state");
        store.set((prev) => ({ ...prev, data: value, error: null }));
      } catch (error) {
        store.set({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    /** 侧边栏底部开关（list 槽位）。 */
    function SidebarToggle(props) {
      const { store } = props;
      const state = useStore(store);
      const [hover, setHover] = React.useState(false);
      return React.createElement(
        "button",
        {
          type: "button",
          title: "dsh工作室",
          "aria-pressed": state.open === true,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: () => {
            const open = !store.get().open;
            store.set({ open });
            writeUiPrefs({ ...store.get(), open });
            if (open) void refresh(store);
          },
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            width: "100%",
            padding: "6px 8px",
            borderRadius: 8,
            border: "none",
            background: hover ? C.hover : "transparent",
            color: C.label2,
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13,
          },
        },
        Icon.Sparkle !== undefined ? React.createElement(Icon.Sparkle, { size: 16 }) : null,
        "工作室",
      );
    }

    function apply(ctx) {
      const prefs = readUiPrefs();
      const store = createStore({
        open: prefs.open === true,
        tab: prefs.tab,
        data: null,
        error: null,
        notice: undefined,
        timeline: loadTimeline(),
        pinInSidebar: prefs.pinInSidebar,
        tintRows: prefs.tintRows,
        hideInSession: prefs.hideInSession,
        showReceipts: prefs.showReceipts,
        dockWidth: prefs.dockWidth,
      });

      const status = {
        version: VERSION,
        get state() {
          return store.get();
        },
        open: () => store.set({ open: true }),
        close: () => store.set({ open: false }),
        refresh: () => refresh(store),
        notice: (text) => store.set({ notice: String(text) }),
        timeline: () => store.get().timeline,
        /** 每个会话的排队深度（只有浏览器这边能看到：宿主推帧里带的）。 */
        queues: () => Object.fromEntries([...queueDepthBySession].map(([id, value]) => [id, value])),
        decorateError: () => decorateError,
        styleTagLength: () => {
          const tag = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
          return tag === null ? 0 : (tag.textContent ?? "").length;
        },
      };
      window[STATUS_KEY] = status;

      void refresh(store);

      // ── S2 客户端层：产品对归档失败只 console.warn（ui-workspace:1847），这里补上可见反馈。
      // 权威层在宿主半边；两层都装，缺一不可。
      let restoreArchive = () => {};
      const workspacesService = ctx.get("workspaces");
      if (workspacesService !== undefined && typeof workspacesService.archiveSession === "function") {
        const original = workspacesService.archiveSession;
        const wrapped = function (sessionId) {
          try {
            const data = store.get().data;
            const member =
              data !== null ? data.members.find((entry) => entry.sessionId === sessionId) : undefined;
            if (member !== undefined && member.locked === true) {
              const label = memberLabel(member, undefined);
              store.set({ notice: `「${label}」已锁定为成员，归档被阻止。要归档请先在工作室面板解锁。` });
              return Promise.reject(new Error(`【dsh工作室】「${label}」已锁定，归档被阻止。`));
            }
          } catch (error) {
            console.warn(PREFIX, "client lock check failed, passing through", error);
          }
          return original.apply(this, arguments);
        };
        wrapped.__dshStudioLock = true;
        workspacesService.archiveSession = wrapped;
        restoreArchive = () => {
          if (workspacesService.archiveSession !== wrapped) return;
          const proto = Object.getPrototypeOf(workspacesService);
          if (proto !== null && proto.archiveSession === original) delete workspacesService.archiveSession;
          else workspacesService.archiveSession = original;
        };
        // 诊断探针：**只读**地走一遍被包装的方法，用于非破坏性验证两层锁。
        // 命中锁定成员时返回 ok:false + 本插件的提示语；非成员会落到原实现（返回它自己的错误）。
        status.probeArchive = async (sessionId) => {
          try {
            await workspacesService.archiveSession(sessionId)
            return { ok: true, via: "passthrough" }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) }
          }
        }
      } else {
        console.warn(PREFIX, "ctx.workspaces.archiveSession unavailable — client-side lock feedback disabled");
      }

      const slots = ctx.get("slots");
      // S4 投递通路：产品的统一 API 客户端（与输入框发消息走的是同一条
      // `POST /api/session.prompt`）。群聊只调 sessions.prompt / sessions.history，不碰别的。
      const connection = ctx.get("connection");
      if (connection === undefined) console.warn(PREFIX, "connection service unavailable — group chat sending disabled");
      const registrations = [];

      // ── S4：原始下行信封 tap → 群聊时间线（只读观测，不改任何状态）──
      /** 每个成员会话的「当前回合是不是群聊回合」标记（跨事件保留）。 */
      const groupTurnState = new Map();

      /** 记一次工具调用（只统计，不改任何会话内容；失败一律忽略）。 */
      const noteToolCall = (sessionId, event) => {
        try {
          const data = store.get().data;
          if (data === null || !data.members.some((member) => member.sessionId === sessionId)) return;
          const summary = summarizeToolCallLite(event.data?.name, event.data?.arguments);
          const now = Date.now();
          const previous = activityBySession.get(sessionId);
          const record =
            previous !== undefined && now - previous.at <= ACTIVITY_WINDOW_MS
              ? previous
              : { edits: 0, commands: 0, reads: 0, others: 0, labels: [] };
          record.at = now;
          const bucket = summary.kind === "edit" ? "edits" : summary.kind === "command" ? "commands" : summary.kind === "read" ? "reads" : "others";
          record[bucket] += 1;
          record.labels = [...record.labels.slice(-2), summary.label];
          record.last = summary.label;
          activityBySession.set(sessionId, record);
        } catch (error) {
          console.warn(PREFIX, "activity note failed (ignored)", error);
        }
      };

      /**
       * 这里原本有一段"脚本式自动回执"（`sendAck`）：某个成员读到 ask 时，由工作室**代它**回一句
       * `🤖 自动回执：已读到你的 ask…`。
       *
       * 它已被**两段式回执协议**取代（用户定的设计，类比 TCP）：
       *   ① **接受状态（传输层 ACK）**：消息投进对方信箱即成立，由发送侧记录 —— 不发任何消息，
       *      在群聊页显示成 `📨 已送达` 状态点，人类视角零文字。见 ChatTab 的 `receiptOf`。
       *   ② **正式回执（应用层确认）**：由**对方 agent 自己**在"队列排空 → 读完任务 → 动手之前"
       *      发出（`say.mjs --ack/--decline`），内容是它自己的话（接/推 + 计划 + 预计时间）。
       *      这条**是给人看的**，所以正常渲染成卡片。
       *
       * 为什么删：脚本那句"已读到"是**代对方说话**，且它会作为一条用户消息落进发起者会话，
       * 既污染人的视野又白占一轮。现在"送到了没有"由 ① 直接回答，不需要任何人开口。
       */

      const recordMemberEvent = (sessionId, event) => {
        try {
          const data = store.get().data;
          if (data === null) return;
          const member = data.members.find((entry) => entry.sessionId === sessionId);
          if (member === undefined) return;
          const state = groupTurnState.get(sessionId) ?? { inGroupTurn: false };
          groupTurnState.set(sessionId, state);
          // 工具调用不进时间线（它不是群聊消息），只用来算"执行中"的观测式进度。
          if (event.type === "tool/call") noteToolCall(sessionId, event);
          foldTimelineEvent(state, sessionId, member, event, (message) => {
            store.set((prev) => {
              if (prev.timeline.some((item) => item.id === message.id)) return prev;
              const next = [...prev.timeline, message];
              return {
                ...prev,
                timeline: next.length > MAX_TIMELINE ? next.slice(next.length - MAX_TIMELINE) : next,
              };
            });
            scheduleTimelineSave(() => store.get().timeline);
          });
        } catch (error) {
          console.warn(PREFIX, "timeline record failed (ignored)", error);
        }
      };

      if (connection !== undefined && connection.api !== undefined) {
        const api = connection.api;
        if (typeof api.subscribeEnvelopes === "function") {
          const unsubscribe = api.subscribeEnvelopes((batch) => {
            try {
              if (!Array.isArray(batch)) return;
              for (const envelope of batch) {
                // 只有 server-request 是下行推来的帧（上行是 client-request，HTTP 回包是 server-response）。
                if (envelope === null || typeof envelope !== "object" || envelope.type !== "server-request") continue;
                // 排队深度：`session/queue` 推帧（订阅时给一次基线，之后每次变更再推）。
                if (envelope.method === "session/queue") {
                  const frame = envelope.payload;
                  const frameSessionId = queueFrameSessionId(frame);
                  if (frameSessionId.length > 0) {
                    const items = Array.isArray(frame.items) ? frame.items : [];
                    // 只统计"要吃掉一整个回合"的那一类；steering/context 会并进当前回合，不算堆积。
                    const queued = items.filter((item) => item !== null && typeof item === "object" && item.placement === "queued");
                    queueDepthBySession.set(frameSessionId, {
                      queued: queued.length,
                      total: items.length,
                      at: Date.now(),
                      // 诊断用：堆的到底是什么（排查"谁发得太快"时，光有数量不够）。
                      samples: queued.slice(0, 12).map((item) => summarizeQueuedMessage(item.message)),
                    });
                  }
                  continue;
                }
                if (envelope.method !== "session/event") continue;
                const frame = envelope.payload;
                if (frame === null || typeof frame !== "object") continue;
                recordMemberEvent(typeof frame.sessionId === "string" ? frame.sessionId : "", frame.event);
              }
            } catch (error) {
              console.warn(PREFIX, "envelope observation failed (ignored)", error);
            }
          });
          registrations.push(unsubscribe);
        } else {
          console.warn(PREFIX, "api.subscribeEnvelopes missing — group timeline cannot observe member sessions");
        }
      }
      if (slots !== undefined) {
        /** 注册到槽位：先带 id/order/label，被拒则退回最小选项（契约不确定时不让插件整体失败）。 */
        const register = (slotName, Component) => {
          const attempt = (options) => {
            try {
              return ctx.slots.register(options, Component);
            } catch (error) {
              console.warn(PREFIX, `register "${slotName}" failed for ${JSON.stringify(options)}`, error);
              return undefined;
            }
          };
          const dispose = attempt({ name: slotName, id: `${PLUGIN_ID}-overlay`, order: 100, label: "dsh工作室" });
          return dispose !== undefined ? dispose : attempt({ name: slotName });
        };

        registrations.push(
          ctx.slots.inject("shell.overlay", () =>
            register("shell.overlay", (props) =>
              // ★ 必须包一层错误边界：面板里任何一个渲染异常都会让**整个面板凭空消失**
              //   （产品槽位把异常吞掉，只留一个空的 `data-slot-error` 容器 —— 用户看到的就是
              //    "工作室界面和呼出按钮都不见了"，且没有任何提示）。
              //   这和之前那次"样式表静默写不进去"是同一类失败：**失败必须可见**。
              React.createElement(PanelBoundary, null, React.createElement(StudioOverlay, { store, workspacesService, connection, ...props })),
            ),
          ),
        );
        registrations.push(
          ctx.slots.inject("sidebar.footer.action", () =>
            register("sidebar.footer.action", () => React.createElement(SidebarToggle, { store })),
          ),
        );
      } else {
        console.warn(PREFIX, "slots service unavailable — no UI registered");
      }

      /**
       * 群聊回合在**单会话视图**里的隐藏：**即时应用 + 保住滚动位置**。
       *
       * 两个真实问题（用户实测反馈）：
       *   1. 群聊回合的节点先生成、后被隐藏 —— 用户看到"思考打印出来、随后又被删掉"的闪烁。
       *      旧的 1.2s 轮询意味着闪烁窗口最长可达 1.2 秒。改成 MutationObserver：
       *      节点一进 DOM 就在**同一帧内**（微任务）打上隐藏属性，肉眼看不到闪烁。
       *   2. 隐藏会让内容变矮，而产品在"接近底部"时会自动跟随 → 用户正在**往上翻历史**时
       *      被打断、跳到最底部。所以应用属性前后量一次高度差，**不在底部时把滚动位置补偿回来**。
       */
      const applyHidingSafely = () => {
        const el = conversationScroller();
        const beforeTop = el !== null ? el.scrollTop : 0;
        const beforeHeight = el !== null ? el.scrollHeight : 0;
        const atBottom = el === null ? true : el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        hideGroupTurns(store.get().hideInSession !== false, store.get().isolateGroupTurns !== false);
        if (el !== null && !atBottom) {
          const delta = el.scrollHeight - beforeHeight;
          if (delta !== 0) el.scrollTop = Math.max(0, beforeTop + delta);
        }
      };
      // 点摘要行时立刻重跑一次（不等下一次 DOM 变更），展开/收起才是"即时"的。
      groupTurnRefresh = applyHidingSafely;
      /** 会话视图的滚动容器（按对话流节点反查，避免依赖产品的 hashed 类名）。 */
      const conversationScroller = () => {
        const sample = document.querySelector("[data-chat-flow-kind]");
        let node = sample !== null ? sample.parentElement : null;
        while (node !== null && node !== document.body) {
          const style = getComputedStyle(node);
          if (style.overflowY === "auto" || style.overflowY === "scroll") return node;
          node = node.parentElement;
        }
        return null;
      };

      // ── 侧边栏：成员行标注 + 颜色标签 + 分组内置顶 + 为面板让位（纯 CSS 呈现）──
      let lastCssKey = "";
      /** 最近一次"界面注入"失败（绝不能静默：曾经因此让整张样式表写不进去而没人发现）。 */
      let decorateError;
      const decorateSidebar = () => {
        try {
          const state = store.get();
          const data = state.data;
          const members = data !== null ? data.members : [];
          const byId = new Set(members.map((member) => member.sessionId));
          // ★ 退役记录**不进侧栏置顶块**（2026-10-20 用户口径）。
          //   原先的逻辑是"只要是成员就抬到顶部，成员之间再按 rank 排"，于是退役记录虽然
          //   `pinned:false`、order 沉到 93+，**仍然留在置顶块里**（只是排在活成员后面）——
          //   用户看到的就是"置顶区里挂着旧会话"。现在让退役记录彻底退出置顶块、交回默认排序，
          //   自然落到整个成员块之下。判据与协议层一致（`src/protocol.js` 的 `isRetired`）：
          //   `locked === false` 或别名带 `旧[` 前缀。
          const retiredIds = new Set(members.filter(isRetiredMember).map((member) => member.sessionId));
          // ★ 成员行的**组内次序**（见 MEMBER_ORDER_BASE 注释）：按成员表顺序排行，逐个给整数 order。
          //   这样"交接后新会话顶在旧会话那一格"才是真的 —— 否则两者只会在成员组里各按更新时间乱排。
          const memberRank = new Map();
          [...members]
            .sort((a, b) =>
              a.pinned !== b.pinned
                ? a.pinned
                  ? -1
                  : 1
                : a.order !== b.order
                  ? a.order - b.order
                  : String(a.sessionId).localeCompare(String(b.sessionId)),
            )
            .forEach((member, index) => memberRank.set(member.sessionId, index));

          // 1) 只标注**会话行**（工作区分组行同样是 treeitem，靠类名后缀排除）
          //
          // ⚠️ **撤标要带滞回**（2026-09-22 加固，用户报"收起后不置顶、展开才重新置顶、关闭又隐藏"）：
          //    解析一失败就立刻 `removeAttribute` 会让"这一帧还没挂上 props"表现成"置顶没了"；
          //    而折叠/展开正是**两套渲染路径**，解析失败更容易发生在那一次切换上。
          //    ⇒ 连续 `MISS_LIMIT` 次都解析不出**且**确定不是成员时，才撤标（不引入"错标"风险：
          //      只要有一次解析出**非成员** id 就立刻撤）。
          let anchors = 0;
          let unresolved = 0;
          for (const row of document.querySelectorAll('[role="treeitem"]')) {
            if (!String(row.className).includes("sessionRow")) continue;
            const wrapper = row.parentElement;
            if (wrapper === null) continue;
            const id = sessionIdOfRow(row);
            if (id === undefined) {
              unresolved += 1;
              const misses = Number(wrapper.getAttribute(MISS_ATTR) ?? "0") + 1;
              wrapper.setAttribute(MISS_ATTR, String(misses));
              if (wrapper.hasAttribute(ROW_ATTR) && misses >= MISS_LIMIT) wrapper.removeAttribute(ROW_ATTR);
            } else {
              wrapper.removeAttribute(MISS_ATTR);
              if (byId.has(id)) {
                wrapper.setAttribute(ROW_ATTR, id);
                const rank = memberRank.get(id);
                // 退役记录：仍算成员（保留标色/圆点），但**不参与置顶排序** ⇒ 交回默认层。
                if (retiredIds.has(id)) wrapper.style.removeProperty("order");
                else if (rank !== undefined) wrapper.style.order = String(MEMBER_ORDER_BASE + rank);
              } else {
                if (wrapper.hasAttribute(ROW_ATTR)) wrapper.removeAttribute(ROW_ATTR);
                // 不再是成员（例如被降级/移除）⇒ 清掉我们写过的内联排序，交回 CSS 默认层级。
                wrapper.style.removeProperty("order");
              }
            }
            if (wrapper.hasAttribute(ROW_ATTR)) anchors += 1;
          }
          // ★ 可核对的读数（写进 html 属性：面板/我/用户都能一眼看到"标注了几行、几行没解析出"）——
          //   这类"外部呈现"最容易静默失效，所以必须留一个能被外部读到的分母。
          document.documentElement.setAttribute(ANCHORS_ATTR, String(anchors));
          document.documentElement.setAttribute(UNRESOLVED_ATTR, String(unresolved));

          // 2) 量出侧边栏实时宽度 → 面板停在它右侧；并按窗口宽度决定**让位**还是**浮层**：
          //    能同时容下「面板最小宽 + 会话列最小宽」就挤开一段留白，否则改为浮层覆盖，
          //    宁可面板压住一点会话，也不能把会话列挤成一条缝（用户报过看不到消息）。
          const parts = frameParts();
          if (parts !== undefined) {
            const sidebarWidth = Math.round(parts.sidebar.getBoundingClientRect().width);
            const available = Math.round(window.innerWidth) - sidebarWidth;
            // ★ 用户**手动拖过**的宽度优先（存在 prefs 里，0 = 自动）。
            //   上限仍然要守住"会话列保底 DOCK_CONVERSATION_MIN"，否则拖到最宽会把会话挤没。
            const userWidth = Number(store.get().dockWidth ?? 0);
            const manual = Number.isFinite(userWidth) && userWidth >= DOCK_WIDTH_MIN;
            const maxAllowed = Math.max(DOCK_WIDTH_MIN, available - DOCK_CONVERSATION_MIN);
            const fit = available - DOCK_CONVERSATION_MIN;
            const overlay = manual ? false : fit < DOCK_WIDTH_MIN;
            const dockWidth = manual
              ? Math.max(DOCK_WIDTH_MIN, Math.min(userWidth, maxAllowed))
              : overlay
                ? DOCK_WIDTH_IDEAL
                : Math.max(DOCK_WIDTH_MIN, Math.min(DOCK_WIDTH_IDEAL, fit));
            document.documentElement.style.setProperty("--dsh-studio-dock-left", `${sidebarWidth}px`);
            document.documentElement.style.setProperty("--dsh-studio-dock-width", `${dockWidth}px`);
            document.documentElement.setAttribute(DOCK_MODE_ATTR, overlay ? "overlay" : "push");
          }

          // 3) 群聊回合在单会话视图里收起（可关）—— 走"即时 + 保滚动位置"的封装
          applyHidingSafely();

          // 4) 成员簇与普通会话之间的分隔线：插在容器末尾，用 order:-1 落到成员簇之后。
          if (state.pinInSidebar !== false) {
            for (const container of document.querySelectorAll(`div:has(> [${ROW_ATTR}])`)) {
              if (container.querySelector(`:scope > [${SEP_ATTR}]`) === null) {
                const separator = document.createElement("div");
                separator.setAttribute(SEP_ATTR, "1");
                container.appendChild(separator);
              }
            }
          }
          for (const separator of document.querySelectorAll(`[${SEP_ATTR}]`)) {
            const parent = separator.parentElement;
            if (state.pinInSidebar === false || parent === null || parent.querySelector(`:scope > [${ROW_ATTR}]`) === null) {
              separator.remove();
            }
          }

          // 4) 重写样式表 —— 只在输入真的变了时才写（消息回流会高频触发 store 变更）
          const cssKey = [
            members.map((member) => `${member.sessionId}:${member.color}`).join(","),
            state.pinInSidebar !== false ? "pin" : "nopin",
            state.tintRows !== false ? "tint" : "notint",
            state.hideInSession !== false ? "hide" : "nohide",
          ].join("|");
          if (cssKey !== lastCssKey) {
            lastCssKey = cssKey;
            const colorRules = members
              .map((member) => `[${ROW_ATTR}="${member.sessionId}"]{--dsh-studio-member-color:${COLOR_OF[member.color] ?? "#8a8f98"};}`)
              .join("");
            ensureStyleTag().textContent = buildSidebarCss(colorRules, state);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (decorateError === undefined || decorateError.message !== message) {
            decorateError = { message, at: new Date().toISOString() };
            console.warn(PREFIX, "sidebar decoration failed (ignored)", error);
          }
        }
      };
      decorateSidebar();
      const decorateTimer = window.setInterval(decorateSidebar, 1200);
      registrations.push(() => window.clearInterval(decorateTimer));
      // 成员或开关一变立刻重绘，不必等下一次轮询
      registrations.push(store.subscribe(() => decorateSidebar()));

      /**
       * 会话视图的**即时**隐藏：会话流是流式追加的（assistant/chunk → 节点不断新增），
       * 等 1.2s 轮询会让用户看到"内容先出现、再被删掉"的闪烁；这里用 MutationObserver
       * 在 DOM 变更后的微任务里就把隐藏属性打上（同一帧，肉眼看不到）。
       * 只监听 childList/subtree —— 我们自己打属性也会触发 attribute 变更，**不监听 attributes** 以免自激。
       */
      let hideScheduled = false;
      const observer = new MutationObserver(() => {
        if (hideScheduled || store.get().hideInSession === false) return;
        hideScheduled = true;
        window.setTimeout(() => {
          hideScheduled = false;
          try {
            applyHidingSafely();
          } catch (error) {
            console.warn(PREFIX, "immediate hiding failed (ignored)", error);
          }
        }, 0);
      });
      try {
        observer.observe(document.body, { childList: true, subtree: true });
        registrations.push(() => observer.disconnect());
      } catch (error) {
        console.warn(PREFIX, "observer unavailable — falling back to polling only", error);
      }
      // 窗口尺寸一变就重新决定「让位 / 浮层」——否则从宽窗口缩到窄窗口时会一直挤着会话列。
      window.addEventListener("resize", decorateSidebar);
      registrations.push(() => window.removeEventListener("resize", decorateSidebar));

      /**
       * ★「展开其余 N 个会话 / 收起」是**点击**触发的重排：那一刻 DOM 会成批替换，
       * 而 1.2s 轮询最多要等 1.2 秒才把它标注回来 —— 用户看到的就是"展开才置顶、收起又没了"的抖动。
       * 这里在**捕获阶段**挂一个 click 监听（覆盖产品自己的处理器），点击后 60ms 再 decorate 一次。
       * 用 `clickPending` 去抖：连点也只重排一次；重建 CSS 另有 `lastCssKey` 守门，不会重复写样式表。
       */
      let clickPending = false;
      const onAnyClick = () => {
        if (clickPending) return;
        clickPending = true;
        window.setTimeout(() => {
          clickPending = false;
          try {
            decorateSidebar();
          } catch (error) {
            console.warn(PREFIX, "decorate after click failed (ignored)", error);
          }
        }, 60);
      };
      document.addEventListener("click", onAnyClick, true);
      registrations.push(() => document.removeEventListener("click", onAnyClick, true));

      ctx.effect(
        () => () => {
          try {
            restoreArchive();
            for (const dispose of registrations) {
              try {
                if (typeof dispose === "function") dispose();
              } catch (error) {
                console.warn(PREFIX, "slot disposer failed (continuing)", error);
              }
            }
            // 只清定时器；时间线数据留在 localStorage（下次加载还在）。
            if (timelineSaveTimer !== undefined) {
              window.clearTimeout(timelineSaveTimer);
              timelineSaveTimer = undefined;
            }
            // 撤掉注入的样式、<html> 上的标记与变量、以及给产品会话行打的锚点。
            const styleTag = document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`);
            if (styleTag !== null) styleTag.remove();
            document.documentElement.removeAttribute(DOCK_ATTR);
            document.documentElement.removeAttribute(DOCK_MODE_ATTR);
            document.documentElement.style.removeProperty("--dsh-studio-dock-left");
            document.documentElement.style.removeProperty("--dsh-studio-dock-width");
            for (const wrapper of document.querySelectorAll(`[${ROW_ATTR}]`)) wrapper.removeAttribute(ROW_ATTR);
            for (const separator of document.querySelectorAll(`[${SEP_ATTR}]`)) separator.remove();
            for (const node of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) node.removeAttribute(HIDDEN_ATTR);
            for (const node of document.querySelectorAll(`[${CLAMP_ATTR}]`)) node.removeAttribute(CLAMP_ATTR);
            if (window[STATUS_KEY] === status) delete window[STATUS_KEY];
          } catch (error) {
            console.warn(PREFIX, "teardown failed (continuing)", error);
          }
        },
        "dsh-studio: client teardown (slots, archive wrap, envelope tap, status)",
      );

      console.log(`${PREFIX} loaded v${VERSION} (client half)`);
      return status;
    }

    return { name: PLUGIN_ID, inject: ["slots"], apply };
  }

  try {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        const React = require("react");
        const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
        const plugin = buildPlugin(React, primitives);
        exports.name = plugin.name;
        exports.inject = plugin.inject;
        exports.apply = plugin.apply;
        return module.exports;
      },
    });
  } catch (error) {
    console.error(PREFIX, "registration failed", error);
  }
})();
