/* 数字彩助手 · 前端应用 */
(function () {
  "use strict";

  var E = window.LotteryEngine;
  var GAMES = E.GAMES;
  var ORDER = E.GAME_ORDER;

  var DATA_URL = "data/lottery.json";
  var REFRESH_MS = 60 * 1000;
  var RECO_MS = 5 * 60 * 1000;
  var LS_DATA = "lottery.cache.v1";
  var LS_GAME = "lottery.game.v1";
  var LS_WINDOW = "lottery.window.v1";
  var LS_HINT = "lottery.hint.v1";

  var state = {
    data: null,
    active: "ssq",
    window: 100,
    recos: {},
    lastFetch: 0,
    nextFetch: 0,
    online: null,
    fetching: false,
    swReady: false,
  };

  var dom = {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function two(n) { return E.pad(n); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatTime(iso) {
    if (!iso) return "--:--";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "--:--";
    try {
      return d.toLocaleTimeString("zh-CN", {
        hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
      });
    } catch (e) {
      return two(d.getHours()) + ":" + two(d.getMinutes());
    }
  }

  function formatMoney(n) {
    if (!n || isNaN(n)) return "";
    if (n >= 1e8) return (n / 1e8).toFixed(2) + " 亿元";
    if (n >= 1e4) return (n / 1e4).toFixed(0) + " 万元";
    return Math.round(n) + " 元";
  }

  function drawsFor(gameId) {
    var g = state.data && state.data.games && state.data.games[gameId];
    return g && Array.isArray(g.draws) ? g.draws : [];
  }

  function gameMeta(id) { return GAMES[id]; }

  /* ---------------- data loading ---------------- */

  function loadCache() {
    var raw = read(LS_DATA);
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.games) {
        state.data = parsed;
        state.lastFetch = parsed.cachedAt || 0;
      }
    } catch (e) { /* ignore */ }
  }

  function validateData(json) {
    if (!json || typeof json !== "object" || !json.games) throw new Error("bad data");
    var count = 0;
    Object.keys(json.games).forEach(function (id) {
      var g = json.games[id];
      if (g && Array.isArray(g.draws)) count += g.draws.length;
    });
    if (!count) throw new Error("empty data");
    return json;
  }

  function latestIssue(gameId) {
    var d = drawsFor(gameId)[0];
    return d ? d.issue : "";
  }

  function fetchData(manual) {
    if (state.fetching) return Promise.resolve();
    state.fetching = true;
    dom.refreshBtn.classList.add("spinning");
    var started = Date.now();

    return fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        var fromCache = res.headers.get("X-Lottery-Cache") === "1";
        return res.json().then(function (json) {
          return { json: json, fromCache: fromCache };
        });
      })
      .then(function (result) {
        var json = result.json;
        validateData(json);
        var before = {};
        ORDER.forEach(function (id) { before[id] = latestIssue(id); });
        var fetchedAt = Date.now();
        json.cachedAt = fetchedAt;
        state.data = json;
        state.online = !result.fromCache;
        state.lastFetch = fetchedAt;
        state.nextFetch = fetchedAt + REFRESH_MS;
        save(LS_DATA, JSON.stringify(json));
        setOnline(state.online);
        ORDER.forEach(function (id) {
          if (latestIssue(id) !== before[id]) delete state.recos[id];
        });
        render();
        if (manual) toast(result.fromCache ? "网络不可用，已读取离线缓存" : "已是最新开奖数据");
      })
      .catch(function (err) {
        state.online = false;
        state.nextFetch = Date.now() + REFRESH_MS;
        if (!state.data) loadCache();
        setOnline(false);
        render();
        if (manual) toast("网络暂时不可用，已显示本地缓存");
        console.warn("fetch lottery data failed:", err);
      })
      .then(function () {
        state.fetching = false;
        window.setTimeout(function () { dom.refreshBtn.classList.remove("spinning"); }, Math.max(300, 700 - (Date.now() - started)));
      });
  }

  function setOnline(ok) {
    if (!dom.netDot) return;
    dom.netDot.classList.toggle("online", ok === true);
    dom.netDot.classList.toggle("offline", ok === false);
    dom.netDot.title = ok ? "数据已连接" : "离线缓存";
  }

  /* ---------------- recommendations ---------------- */

  function ensureReco(gameId, force) {
    var cur = state.recos[gameId];
    var draws = drawsFor(gameId);
    var latest = draws[0] ? draws[0].issue : "";
    var stale = !cur || force || cur.window !== state.window || cur.latest !== latest ||
      (Date.now() - cur.generatedAt > RECO_MS);
    if (stale) {
      var result = E.recommend(gameId, draws, { window: state.window, sets: 2 });
      result.latest = latest;
      state.recos[gameId] = result;
    }
    return state.recos[gameId];
  }

  /* ---------------- rendering ---------------- */

  function ballsHTML(nums, klass, small, startDelay) {
    var out = "";
    for (var i = 0; i < nums.length; i++) {
      var delay = (startDelay || 0) + i * 22;
      out += '<span class="ball ' + klass + (small ? " sm" : "") + '" style="animation-delay:' + delay + 'ms">' +
        escapeHtml(nums[i]) + "</span>";
    }
    return out;
  }

  function numberBallsHTML(gameId, nums, klass, small) {
    var out = "";
    for (var i = 0; i < nums.length; i++) {
      out += '<span class="ball ' + klass + (small ? " sm" : "") + '" style="animation-delay:' + (i * 22) + 'ms">' +
        two(nums[i]) + "</span>";
    }
    return out;
  }

  function latestBallsHTML(gameId, draw) {
    var game = gameMeta(gameId);
    if (!draw) return '<span class="ball muted">?</span>';
    if (game.kind === "digits") {
      return E.mainNumbers(game, draw).map(function (d, i) {
        return '<span class="ball ' + (gameId === "fc3d" ? "teal" : "purple") + '" style="animation-delay:' + (i * 24) + 'ms">' + d + "</span>";
      }).join("");
    }
    if (gameId === "kl8") {
      return '<div class="balls grid-10">' + E.mainNumbers(game, draw).map(function (n, i) {
        return '<span class="ball pink xs" style="animation-delay:' + Math.min(i * 14, 300) + 'ms">' + two(n) + "</span>";
      }).join("") + "</div>";
    }
    var main = E.mainNumbers(game, draw);
    var special = E.specialNumbers(game, draw);
    var mainClass = gameId === "dlt" ? "orange" : "red";
    var out = numberBallsHTML(gameId, main, mainClass, false);
    if (special.length) out += '<span class="plus">＋</span>' + numberBallsHTML(gameId, special, "blue", false);
    return out;
  }

  function recBallsHTML(gameId, set) {
    var game = gameMeta(gameId);
    if (game.kind === "digits") {
      return set.primary.map(function (d, i) {
        return '<span class="ball ' + (gameId === "fc3d" ? "teal" : "purple") + '" style="animation-delay:' + (i * 26) + 'ms">' + d + "</span>";
      }).join("");
    }
    if (gameId === "kl8") {
      return '<div class="balls grid-5">' + set.primary.map(function (n, i) {
        return '<span class="ball pink" style="animation-delay:' + (i * 18) + 'ms">' + two(n) + "</span>";
      }).join("") + "</div>";
    }
    var out = numberBallsHTML(gameId, set.primary, gameId === "dlt" ? "orange" : "red", false).replace(/animation-delay:(\d+)ms/g, function (m, d) {
      return "animation-delay:" + (parseInt(d, 10) + 20) + "ms";
    });
    if (set.special && set.special.length) {
      out += '<span class="plus">＋</span>' + numberBallsHTML(gameId, set.special, "blue", false);
    }
    return out;
  }

  function setText(gameId, set) {
    var game = gameMeta(gameId);
    if (game.kind === "digits") return game.name + "：" + set.primary.join(" ");
    var text = game.name + "：" + set.primary.map(two).join(" ");
    if (set.special && set.special.length) text += " ＋ " + set.special.map(two).join(" ");
    return text;
  }

  function copyButtonHTML(gameId, set) {
    return '<button class="copy-btn" type="button" data-copy="' + escapeHtml(setText(gameId, set)) + '" aria-label="复制这注号码">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M6 15V6a2 2 0 0 1 2-2h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
      "</button>";
  }

  function recommendationHTML(gameId, reco) {
    return reco.sets.map(function (set, i) {
      return '<div class="rec-set">' +
        '<div class="rec-head"><span class="set-label">第 ' + (i + 1) + ' 注</span>' +
        copyButtonHTML(gameId, set) + "</div>" +
        '<div class="rec-balls">' + recBallsHTML(gameId, set) + "</div>" +
        "</div>";
    }).join("");
  }

  function statChips(list, cls, unitLabel) {
    return list.map(function (item) {
      return '<span class="chip ' + cls + '" title="出现 ' + item.c + ' 次">' +
        (item.n < 10 ? "0" + item.n : item.n) +
        "<small>" + item.c + "次</small></span>";
    }).join("");
  }

  function omitChips(list) {
    return list.map(function (item) {
      return '<span class="chip omit">' + (item.n < 10 ? "0" + item.n : item.n) +
        "<small>遗漏" + item.omit + "期</small></span>";
    }).join("");
  }

  function statsHTML(gameId, stats) {
    if (!stats) return '<p class="warn-text">暂无足够的历史数据。</p>';
    if (stats.kind === "digits") {
      var rows = stats.positions.map(function (p) {
        return "<tr>" +
          '<td class="pos">' + escapeHtml(p.name) + "</td>" +
          '<td><span class="mini hot">' + p.hot.map(function (x) { return "<span>" + x.d + "</span>"; }).join("") + "</span></td>" +
          '<td><span class="mini cold">' + p.cold.map(function (x) { return "<span>" + x.d + "</span>"; }).join("") + "</span></td>" +
          '<td><span class="mini">' + p.omit.map(function (x) { return "<span>" + x.omit + "</span>"; }).join("") + "</span></td>" +
          "</tr>";
      }).join("");
      return '<table class="digit-table"><thead><tr><th>位置</th><th>热码</th><th>冷码</th><th>遗漏</th></tr></thead><tbody>' + rows + "</tbody></table>" +
        '<p class="hint-text">热码 / 冷码按近 ' + stats.draws + " 期出现次数统计，遗漏为连续未出现期数。</p>";
    }

    var game = gameMeta(gameId);
    var html = "";
    html += '<div class="stat-group"><div class="stat-title"><b>' + game.mainLabel + '热号</b><span>近' + stats.draws + "期</span></div>" +
      '<div class="chips">' + statChips(stats.main.hot, "hot") + "</div></div>";
    html += '<div class="stat-group"><div class="stat-title"><b>' + game.mainLabel + '冷号</b><span>回补观察</span></div>' +
      '<div class="chips">' + statChips(stats.main.cold, "cold") + "</div></div>";
    html += '<div class="stat-group"><div class="stat-title"><b>' + game.mainLabel + '遗漏</b><span>久未开出</span></div>' +
      '<div class="chips">' + omitChips(stats.main.omit) + "</div></div>";
    if (stats.special) {
      html += '<div class="stat-group"><div class="stat-title"><b>' + game.specialLabel + '热号</b><span>近' + stats.draws + "期</span></div>" +
        '<div class="chips">' + statChips(stats.special.hot, "hot") + "</div></div>";
      html += '<div class="stat-group"><div class="stat-title"><b>' + game.specialLabel + '冷号</b><span>回补观察</span></div>' +
        '<div class="chips">' + statChips(stats.special.cold, "cold") + "</div></div>";
    }
    return html;
  }

  function shapeHTML(gameId, draw) {
    if (!draw) return "";
    return E.shapeOf(gameId, draw).map(function (s) {
      return '<span class="shape">' + s.label + " <b>" + escapeHtml(s.value) + "</b></span>";
    }).join("");
  }

  function aboutHTML() {
    return '<section class="card about-card">' +
      '<div class="card-head"><div class="card-title"><span class="icon">ⓘ</span>关于与说明</div><span class="badge gray">v1.0.0</span></div>' +
      '<ul class="about-list">' +
      '<li><span class="bullet">↻</span><div><b>自动刷新</b>：打开页面后每 60 秒检查一次开奖数据，开奖后自动更新；推荐号码每 5 分钟自动换一注。</div></li>' +
      '<li><span class="bullet">↗</span><div><b>数据来源</b>：<a href="https://www.cwl.gov.cn/" target="_blank" rel="noopener">中国福利彩票</a>、<a href="https://www.sporttery.cn/" target="_blank" rel="noopener">中国体育彩票</a>官方公开接口；海外 Runner 自动回退到 500.com 公开历史页。GitHub Actions 每 10 分钟同步。</div></li>' +
      '<li><span class="bullet">∑</span><div><b>推荐算法</b>：统计近 30 / 100 期号码频率与近期热度并加入随机扰动，同时约束奇偶、大小、区间和和值形态。任何模型都不能预测开奖结果。</div></li>' +
      '<li><span class="bullet">＋</span><div><b>装到桌面</b>：iPhone 用 Safari 打开 → 点底部「分享」→「添加到主屏幕」，即可全屏使用并支持离线缓存。</div></li>' +
      "</ul>" +
      '<div class="disclaimer">理性购彩，量力而行。未满 18 周岁禁止购买彩票。本应用仅提供公开开奖信息与娱乐性号码生成，不提供购彩、代购或兑奖服务。</div>' +
      "</section>";
  }

  function renderTabs() {
    if (!dom.tabs) return;
    dom.tabs.innerHTML = ORDER.map(function (id) {
      var g = gameMeta(id);
      return '<button class="tab" type="button" role="tab" data-game="' + id + '" aria-selected="' +
        (id === state.active ? "true" : "false") + '" style="--dot:' + g.color + '">' +
        '<span class="dot"></span>' + escapeHtml(g.name) + "</button>";
    }).join("");
  }

  function render() {
    if (!dom.main) return;
    renderTabs();
    var gameId = state.active;
    var game = gameMeta(gameId);
    var draws = drawsFor(gameId);
    var draw = draws[0];

    if (!draw) {
      dom.main.innerHTML = '<section class="card empty-card">' +
        "<h2>正在获取开奖数据</h2>" +
        "<p>第一次打开需要联网载入，请稍候或点右上角刷新。</p>" +
        '<button class="btn btn-ghost" type="button" data-retry style="margin-top:14px">重新加载</button>' +
        "</section>" + aboutHTML();
      return;
    }

    var reco = ensureReco(gameId);
    var stats = E.computeStats(gameId, draws, state.window);
    var next = E.nextDraw(gameId);
    var pool = draw.pool || 0;
    var updated = formatTime(state.data.updated || state.data.cachedAt);
    var offline = state.online === false;

    var notice = offline
      ? '<div class="notice"><span class="n-dot"></span><span>网络暂时不可用，正在显示本地缓存（更新于 ' +
        escapeHtml(updated) + "）。网络恢复后会自动同步。</span></div>"
      : "";

    var main = notice +
      '<section class="card draw-card">' +
      '<div class="draw-top">' +
      '<div class="draw-title">' +
      '<div class="draw-issue"><span class="live-dot"></span>第 ' + escapeHtml(draw.issue) + " 期" +
      '<span class="badge gray">' + escapeHtml(game.tag) + "</span></div>" +
      '<span class="draw-date">' + escapeHtml(draw.date || "") + " 开奖</span>" +
      "</div>" +
      '<div class="countdown-box"><span class="countdown-label">距下期开奖</span>' +
      '<span class="countdown" data-countdown aria-live="off">--:--:--</span></div>' +
      "</div>" +
      '<div class="draw-numbers" role="img" aria-label="' + escapeHtml(game.name + "最新开奖号码") + '">' +
      latestBallsHTML(gameId, draw) + "</div>" +
      '<div class="pool-line">' +
      (pool ? "<span>奖池 <b>" + escapeHtml(formatMoney(pool)) + "</b></span>" : "") +
      "<span>更新 <b>" + escapeHtml(updated) + "</b></span>" +
      '<span data-refresh-countdown>60 秒后检查</span>' +
      "</div>" +
      "</section>" +

      '<section class="card">' +
      '<div class="card-head"><div class="card-title"><span class="icon">✦</span>智能推荐</div>' +
      '<span class="badge">近 ' + state.window + " 期</span></div>" +
      recommendationHTML(gameId, reco) +
      '<div class="rec-foot">' +
      '<button class="btn btn-primary" type="button" data-action="reshuffle">换一注</button>' +
      '<div class="auto-line" data-auto-line><span class="dot"></span><span>每 5 分钟自动换号<br><span data-reco-countdown>05:00</span> 后更新</span></div>' +
      "</div>" +
      "</section>" +

      '<section class="card">' +
      '<div class="card-head"><div class="card-title"><span class="icon">◎</span>冷热统计</div>' +
      '<div class="segmented">' +
      '<button class="seg-btn' + (state.window === 30 ? " active" : "") + '" type="button" data-window="30">近30期</button>' +
      '<button class="seg-btn' + (state.window === 100 ? " active" : "") + '" type="button" data-window="100">近100期</button>' +
      "</div></div>" +
      statsHTML(gameId, stats) +
      '<div class="shape-line">' + shapeHTML(gameId, draw) + "</div>" +
      "</section>" +
      aboutHTML();

    dom.main.innerHTML = main;
    tick();
  }

  /* ---------------- ticking ---------------- */

  var lastRecoRender = 0;

  function tick() {
    var gameId = state.active;

    var countdownEls = $$("[data-countdown]");
    if (countdownEls.length) {
      var next = E.nextDraw(gameId);
      var remain = next - Date.now();
      var text = E.formatDuration(remain);
      countdownEls.forEach(function (el) {
        el.textContent = text;
        el.classList.toggle("near", remain > 0 && remain < 10 * 60 * 1000);
      });
    }

    var fetchEls = $$("[data-refresh-countdown]");
    if (fetchEls.length) {
      var secs = Math.max(0, Math.ceil((state.nextFetch - Date.now()) / 1000));
      fetchEls.forEach(function (el) { el.textContent = secs + " 秒后检查"; });
    }

    var reco = state.recos[gameId];
    var recoEls = $$("[data-reco-countdown]");
    if (reco && recoEls.length) {
      var left = Math.max(0, reco.generatedAt + RECO_MS - Date.now());
      var label = E.formatDuration(left);
      recoEls.forEach(function (el) { el.textContent = label; });
      if (left <= 0 && document.visibilityState === "visible" && Date.now() - lastRecoRender > 3000) {
        lastRecoRender = Date.now();
        ensureReco(gameId, true);
        render();
      }
    }
  }

  /* ---------------- UI helpers ---------------- */

  var toastTimer = 0;
  function toast(msg) {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { dom.toast.classList.remove("show"); }, 2000);
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? "已复制：" + text : "复制失败，请长按号码手动复制");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("已复制：" + text);
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    dom.refreshBtn.addEventListener("click", function () { fetchData(true); });

    dom.tabs.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-game]");
      if (!btn) return;
      var id = btn.getAttribute("data-game");
      if (!GAMES[id] || id === state.active) return;
      state.active = id;
      save(LS_GAME, id);
      ensureReco(id);
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    dom.main.addEventListener("click", function (event) {
      var copyBtn = event.target.closest("[data-copy]");
      if (copyBtn) {
        copyText(copyBtn.getAttribute("data-copy"));
        return;
      }
      var winBtn = event.target.closest("[data-window]");
      if (winBtn) {
        var w = Number(winBtn.getAttribute("data-window"));
        if (w !== state.window) {
          state.window = w;
          save(LS_WINDOW, String(w));
          delete state.recos[state.active];
          render();
          toast("统计区间已切换为近 " + w + " 期");
        }
        return;
      }
      var action = event.target.closest("[data-action]");
      if (action && action.getAttribute("data-action") === "reshuffle") {
        ensureReco(state.active, true);
        render();
        toast("已换一注，仅供娱乐");
        return;
      }
      if (event.target.closest("[data-retry]")) {
        fetchData(true);
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        if (Date.now() >= state.nextFetch - 5000) fetchData(false);
        tick();
      }
    });

    window.addEventListener("online", function () { fetchData(false); });
    window.addEventListener("offline", function () { setOnline(false); });

    dom.installClose.addEventListener("click", function () {
      dom.installHint.hidden = true;
      save(LS_HINT, String(Date.now()));
    });
  }

  /* ---------------- install hint / sw ---------------- */

  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  function maybeShowInstallHint() {
    if (isStandalone()) return;
    var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!isIOS) return;
    var dismissed = Number(read(LS_HINT) || 0);
    if (Date.now() - dismissed < 7 * 86400000) return;
    window.setTimeout(function () {
      if (!isStandalone()) dom.installHint.hidden = false;
    }, 1800);
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) {
      dom.swState.textContent = "浏览器不支持离线缓存";
      return;
    }
    var secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (!secure) {
      dom.swState.textContent = "需 https 才能离线";
      return;
    }
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      dom.swState.textContent = "离线缓存已就绪";
      window.setInterval(function () { reg.update(); }, 30 * 60 * 1000);
    }).catch(function (err) {
      dom.swState.textContent = "离线缓存未启用";
      console.warn("SW register failed:", err);
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    dom.main = $("#main");
    dom.tabs = $("#tabs");
    dom.refreshBtn = $("#refreshBtn");
    dom.netDot = $("#netDot");
    dom.toast = $("#toast");
    dom.installHint = $("#installHint");
    dom.installClose = $("#installClose");
    dom.swState = $("#swState");

    var savedGame = read(LS_GAME);
    if (savedGame && GAMES[savedGame]) state.active = savedGame;
    var savedWindow = Number(read(LS_WINDOW));
    if (savedWindow === 30 || savedWindow === 100) state.window = savedWindow;

    state.nextFetch = Date.now() + REFRESH_MS;
    loadCache();
    renderTabs();
    render();
    bindEvents();
    maybeShowInstallHint();
    registerSW();
    setOnline(null);

    fetchData(false);
    window.setInterval(function () {
      if (document.visibilityState === "visible" && Date.now() >= state.nextFetch) fetchData(false);
    }, 5000);
    window.setInterval(tick, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
