/*!
 * 数字彩助手 · 推荐引擎
 * 纯前端、无依赖。基于近 N 期频率 + 近期热度 + 随机扰动生成号码，
 * 并做奇偶、大小、区间、和值等形态约束。仅供娱乐。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LotteryEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var GAMES = {
    ssq: {
      id: "ssq", name: "双色球", tag: "福彩", color: "#ff5a4d",
      kind: "numbers",
      mainLabel: "红球", specialLabel: "蓝球",
      mainMin: 1, mainMax: 33, mainCount: 6,
      specialMin: 1, specialMax: 16, specialCount: 1,
      schedule: { days: [0, 2, 4], hour: 21, minute: 15 },
    },
    dlt: {
      id: "dlt", name: "大乐透", tag: "体彩", color: "#ff9040",
      kind: "numbers",
      mainLabel: "前区", specialLabel: "后区",
      mainMin: 1, mainMax: 35, mainCount: 5,
      specialMin: 1, specialMax: 12, specialCount: 2,
      schedule: { days: [1, 3, 6], hour: 21, minute: 25 },
    },
    fc3d: {
      id: "fc3d", name: "福彩3D", tag: "福彩", color: "#25cdb9",
      kind: "digits", digits: 3,
      positions: ["百位", "十位", "个位"],
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 21, minute: 15 },
    },
    p5: {
      id: "p5", name: "排列5", tag: "体彩", color: "#9070fb",
      kind: "digits", digits: 5,
      positions: ["万位", "千位", "百位", "十位", "个位"],
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 21, minute: 25 },
    },
    kl8: {
      id: "kl8", name: "快乐8", tag: "福彩", color: "#ff62aa",
      kind: "numbers",
      mainLabel: "选十", specialLabel: "",
      mainMin: 1, mainMax: 80, mainCount: 10,
      specialMin: 0, specialMax: 0, specialCount: 0,
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 21, minute: 30 },
    },
  };

  var GAME_ORDER = ["ssq", "dlt", "fc3d", "p5", "kl8"];

  function range(min, max) {
    var out = [];
    for (var i = min; i <= max; i++) out.push(i);
    return out;
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    if (seed != null) return mulberry32(seed);
    var s = 0;
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      var buf = new Uint32Array(2);
      crypto.getRandomValues(buf);
      s = (buf[0] ^ Math.imul(buf[1], 0x9e3779b1)) >>> 0;
    } else {
      s = (Date.now() ^ Math.imul(Math.random() * 1e9, 0x85ebca6b)) >>> 0;
    }
    return mulberry32(s);
  }

  /* ---------------- draw accessors ---------------- */

  function mainNumbers(game, draw) {
    if (!draw) return [];
    if (game.kind === "digits") return (draw.digits || []).slice();
    if (game.id === "ssq") return (draw.red || []).slice();
    if (game.id === "dlt") return (draw.front || []).slice();
    if (game.id === "kl8") return (draw.nums || []).slice();
    return [];
  }

  function specialNumbers(game, draw) {
    if (!draw) return [];
    if (game.id === "ssq") return (draw.blue || []).slice();
    if (game.id === "dlt") return (draw.back || []).slice();
    return [];
  }

  /* ---------------- sampling ---------------- */

  function weightedSample(pool, weights, k, rng) {
    var items = pool.map(function (v, i) {
      return { v: v, w: Math.max(0.0001, weights[i] || 0.0001) };
    });
    var picked = [];
    var n = Math.min(k, items.length);
    for (var j = 0; j < n; j++) {
      var total = 0;
      for (var i = 0; i < items.length; i++) total += items[i].w;
      var r = rng() * total;
      var idx = 0;
      for (; idx < items.length; idx++) {
        r -= items[idx].w;
        if (r <= 0) break;
      }
      if (idx >= items.length) idx = items.length - 1;
      picked.push(items[idx].v);
      items.splice(idx, 1);
    }
    return picked.sort(function (a, b) { return a - b; });
  }

  function frequency(counts, values) {
    var out = {};
    values.forEach(function (v) { out[v] = counts[v] || 0; });
    return out;
  }

  function normalize(obj) {
    var vals = Object.keys(obj).map(function (k) { return obj[k]; });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    var span = max - min;
    var out = {};
    Object.keys(obj).forEach(function (k) {
      out[k] = span > 0 ? (obj[k] - min) / span : 0.5;
    });
    return out;
  }

  function weightsFor(pool, counts, recentCounts, rng, heat) {
    var freq = normalize(frequency(counts, pool));
    var recent = normalize(frequency(recentCounts, pool));
    var h = heat == null ? 1 : heat;
    return pool.map(function (v) {
      return 0.62 + h * 1.35 * freq[v] + h * 0.55 * recent[v] + 0.22 * rng();
    });
  }

  function countValues(values, target) {
    var counts = {};
    target.forEach(function (v) { counts[v] = 0; });
    values.forEach(function (v) { if (v in counts) counts[v] += 1; });
    return counts;
  }

  function recentCounts(draws, getter, target, window) {
    var counts = {};
    target.forEach(function (v) { counts[v] = 0; });
    draws.slice(0, window || 30).forEach(function (d) {
      getter(d).forEach(function (v) { if (v in counts) counts[v] += 1; });
    });
    return counts;
  }

  /* ---------------- constraints ---------------- */

  function zoneCounts(nums, cuts) {
    var zones = cuts.map(function () { return 0; });
    nums.forEach(function (n) {
      for (var i = 0; i < cuts.length; i++) {
        if (n <= cuts[i]) { zones[i] += 1; return; }
      }
    });
    return zones;
  }

  function consecutivePairs(nums) {
    var n = 0;
    for (var i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] === 1) n += 1;
    return n;
  }

  function validateSSQ(nums) {
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    var odd = nums.filter(function (n) { return n % 2 === 1; }).length;
    var z = zoneCounts(nums, [11, 22, 33]);
    return sum >= 78 && sum <= 142 && odd >= 2 && odd <= 4 &&
      z[0] >= 1 && z[1] >= 1 && z[2] >= 1 && consecutivePairs(nums) <= 2;
  }

  function validateDLT(nums) {
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    var odd = nums.filter(function (n) { return n % 2 === 1; }).length;
    var z = zoneCounts(nums, [12, 24, 35]);
    return sum >= 62 && sum <= 128 && odd >= 2 && odd <= 3 &&
      z[0] >= 1 && z[1] >= 1 && z[2] >= 1 && consecutivePairs(nums) <= 2;
  }

  function validateKL8(nums) {
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    var odd = nums.filter(function (n) { return n % 2 === 1; }).length;
    var z = zoneCounts(nums, [20, 40, 60, 80]);
    return sum >= 325 && sum <= 485 && odd >= 3 && odd <= 7 &&
      z[0] >= 1 && z[1] >= 1 && z[2] >= 1 && z[3] >= 1 &&
      z.every(function (c) { return c <= 4; });
  }

  function constrainedSample(pool, weights, k, validate, rng, attempts) {
    var best = null;
    var tries = attempts || 600;
    for (var i = 0; i < tries; i++) {
      var picked = weightedSample(pool, weights, k, rng);
      if (validate(picked)) return picked;
      if (!best) best = picked;
    }
    return best;
  }

  /* ---------------- recommendation ---------------- */

  function drawCounts(game, draws, window) {
    var mainPool = game.kind === "digits" ? range(0, 9) : range(game.mainMin, game.mainMax);
    var specialPool = game.specialCount ? range(game.specialMin, game.specialMax) : [];
    var mainAll = [];
    var specialAll = [];
    var recentMain = [];
    var recentSpecial = [];
    draws.slice(0, window).forEach(function (d) {
      mainAll = mainAll.concat(mainNumbers(game, d));
      specialAll = specialAll.concat(specialNumbers(game, d));
    });
    draws.slice(0, Math.min(30, window)).forEach(function (d) {
      recentMain = recentMain.concat(mainNumbers(game, d));
      recentSpecial = recentSpecial.concat(specialNumbers(game, d));
    });
    return {
      mainPool: mainPool,
      specialPool: specialPool,
      main: countValues(mainAll, mainPool),
      mainRecent: countValues(recentMain, mainPool),
      special: countValues(specialAll, specialPool),
      specialRecent: countValues(recentSpecial, specialPool),
    };
  }

  function recommend(gameId, draws, opts) {
    var game = GAMES[gameId];
    if (!game) throw new Error("unknown game: " + gameId);
    opts = opts || {};
    var window = opts.window || 100;
    var rng = makeRng(opts.seed);
    var counts = drawCounts(game, draws || [], window);
    var sets = [];
    var seen = {};
    var wanted = opts.sets || 2;
    var attempts = 0;

    while (sets.length < wanted && attempts < 30) {
      attempts += 1;
      var set = { primary: [], special: [] };
      if (game.kind === "digits") {
        set.primary = recommendDigits(game, draws || [], window, rng);
      } else {
        var mainWeights = weightsFor(counts.mainPool, counts.main, counts.mainRecent, rng, 1);
        var validate = gameId === "ssq" ? validateSSQ : gameId === "dlt" ? validateDLT : validateKL8;
        set.primary = constrainedSample(counts.mainPool, mainWeights, game.mainCount, validate, rng);
        if (game.specialCount) {
          var sw = weightsFor(counts.specialPool, counts.special, counts.specialRecent, rng, 1.15);
          set.special = weightedSample(counts.specialPool, sw, game.specialCount, rng);
        }
      }
      var key = set.primary.join(",") + "|" + set.special.join(",");
      if (!seen[key]) {
        seen[key] = 1;
        sets.push(set);
      }
    }

    return { gameId: gameId, window: window, sets: sets, generatedAt: Date.now() };
  }

  function recommendDigits(game, draws, window, rng) {
    var digits = game.digits;
    var recent = draws.slice(0, Math.min(30, window));
    var result = [];
    for (var pos = 0; pos < digits; pos++) {
      var counts = {};
      var recentCountsMap = {};
      var pool = range(0, 9);
      pool.forEach(function (d) { counts[d] = 0; recentCountsMap[d] = 0; });
      draws.slice(0, window).forEach(function (dr) {
        var v = (dr.digits || [])[pos];
        if (v != null && v in counts) counts[v] += 1;
      });
      recent.forEach(function (dr) {
        var v = (dr.digits || [])[pos];
        if (v != null && v in recentCountsMap) recentCountsMap[v] += 1;
      });
      var w = weightsFor(pool, counts, recentCountsMap, rng, 0.75);
      result.push(weightedSample(pool, w, 1, rng)[0]);
    }
    // 避免全同号（概率极低但影响观感），最多重试 20 次
    var allSame = result.every(function (d) { return d === result[0]; });
    if (allSame && game.digits > 1) result[game.digits - 1] = (result[0] + 1 + Math.floor(rng() * 8)) % 10;
    return result;
  }

  /* ---------------- statistics ---------------- */

  function omitFor(draws, pool, getter) {
    return pool.map(function (v) {
      var omit = draws.length;
      for (var i = 0; i < draws.length; i++) {
        if (getter(draws[i]).indexOf(v) >= 0) { omit = i; break; }
      }
      return { n: v, omit: omit };
    });
  }

  function topBy(list, key, desc, count) {
    return list.slice().sort(function (a, b) {
      return desc ? b[key] - a[key] : a[key] - b[key];
    }).slice(0, count);
  }

  function computeStats(gameId, draws, window) {
    var game = GAMES[gameId];
    var recent = (draws || []).slice(0, window);
    if (!game || !recent.length) return null;

    if (game.kind === "digits") {
      var positions = game.positions.map(function (name, pos) {
        var counts = {};
        range(0, 9).forEach(function (d) { counts[d] = 0; });
        recent.forEach(function (dr) {
          var v = (dr.digits || [])[pos];
          if (v != null && v in counts) counts[v] += 1;
        });
        var list = Object.keys(counts).map(function (k) { return { d: Number(k), c: counts[k] }; });
        var omits = omitFor(recent, range(0, 9), function (dr) { return [(dr.digits || [])[pos]]; });
        return {
          name: name,
          hot: topBy(list, "c", true, 3),
          cold: topBy(list, "c", false, 2),
          omit: topBy(omits, "omit", true, 2),
        };
      });
      return { kind: "digits", positions: positions, draws: recent.length };
    }

    var mainAll = [];
    recent.forEach(function (d) { mainAll = mainAll.concat(mainNumbers(game, d)); });
    var pool = range(game.mainMin, game.mainMax);
    var counts = countValues(mainAll, pool);
    var mainList = pool.map(function (n) { return { n: n, c: counts[n] }; });
    var mainOmits = omitFor(recent, pool, function (d) { return mainNumbers(game, d); });

    var result = {
      kind: "numbers",
      draws: recent.length,
      main: {
        hot: topBy(mainList, "c", true, game.id === "kl8" ? 10 : 8),
        cold: topBy(mainList, "c", false, game.id === "kl8" ? 6 : 5),
        omit: topBy(mainOmits, "omit", true, 4),
      },
    };

    if (game.specialCount) {
      var specialAll = [];
      recent.forEach(function (d) { specialAll = specialAll.concat(specialNumbers(game, d)); });
      var spool = range(game.specialMin, game.specialMax);
      var scounts = countValues(specialAll, spool);
      var slist = spool.map(function (n) { return { n: n, c: scounts[n] }; });
      result.special = {
        hot: topBy(slist, "c", true, 5),
        cold: topBy(slist, "c", false, 3),
        omit: topBy(omitFor(recent, spool, function (d) { return specialNumbers(game, d); }), "omit", true, 3),
      };
    }
    return result;
  }

  /* ---------------- shape ---------------- */

  function shapeOf(gameId, draw) {
    var game = GAMES[gameId];
    if (!game || !draw) return [];
    var nums = mainNumbers(game, draw);

    if (game.kind === "digits") {
      var sum = nums.reduce(function (a, b) { return a + b; }, 0);
      var odd = nums.filter(function (n) { return n % 2 === 1; }).length;
      return [
        { label: "和值", value: sum },
        { label: "奇偶", value: odd + ":" + (nums.length - odd) },
        { label: "大小", value: nums.filter(function (n) { return n >= 5; }).length + ":" + nums.filter(function (n) { return n < 5; }).length },
      ];
    }

    var total = nums.reduce(function (a, b) { return a + b; }, 0);
    var oddCount = nums.filter(function (n) { return n % 2 === 1; }).length;
    var bigCut = gameId === "kl8" ? 40 : gameId === "dlt" ? 18 : 17;
    var big = nums.filter(function (n) { return n > bigCut; }).length;
    var span = nums.length ? Math.max.apply(null, nums) - Math.min.apply(null, nums) : 0;
    var cuts;
    if (gameId === "ssq") cuts = [11, 22, 33];
    else if (gameId === "dlt") cuts = [12, 24, 35];
    else cuts = [20, 40, 60, 80];
    var zones = zoneCounts(nums, cuts).join(":");
    return [
      { label: "和值", value: total },
      { label: "奇偶", value: oddCount + ":" + (nums.length - oddCount) },
      { label: "大小", value: big + ":" + (nums.length - big) },
      { label: "跨度", value: span },
      { label: gameId === "kl8" ? "区间" : "三区", value: zones },
    ];
  }

  /* ---------------- schedule ---------------- */

  function nextDraw(gameId, now) {
    var game = GAMES[gameId];
    if (!game) return 0;
    var t = (now == null ? Date.now() : now) + 8 * 3600 * 1000;
    var d = new Date(t);
    var day = d.getUTCDay();
    var nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    var targetMin = game.schedule.hour * 60 + game.schedule.minute;
    var delta = 0;
    var days = game.schedule.days || [0, 1, 2, 3, 4, 5, 6];
    var found = false;
    for (var i = 0; i < 8; i++) {
      if (days.indexOf((day + i) % 7) >= 0) {
        if (i > 0 || targetMin > nowMin) { delta = i; found = true; break; }
      }
    }
    if (!found) delta = 1;
    var base = Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
      game.schedule.hour, game.schedule.minute, 0, 0
    ) - 8 * 3600 * 1000;
    return base + delta * 86400000;
  }

  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var days = Math.floor(total / 86400);
    var h = Math.floor((total % 86400) / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var clock = pad(h) + ":" + pad(m) + ":" + pad(s);
    return days > 0 ? days + "天 " + clock : clock;
  }

  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  var engine = {
    GAMES: GAMES,
    GAME_ORDER: GAME_ORDER,
    recommend: recommend,
    computeStats: computeStats,
    nextDraw: nextDraw,
    formatDuration: formatDuration,
    shapeOf: shapeOf,
    mainNumbers: mainNumbers,
    specialNumbers: specialNumbers,
    pad: pad,
    range: range,
    makeRng: makeRng,
    shuffle: shuffle,
  };

  return engine;
});
