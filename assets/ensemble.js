/*!
 * 数字彩助手 · 60 公式集成投票引擎
 * 每个模型独立计算评分，给前 3 名各投 1 票；汇总票数后按票数选号，
 * 再做奇偶、区间、和值、连号等形态约束。
 * 说明：彩票每期开奖是独立随机事件，本引擎只提供统计共识与娱乐参考，
 * 不能提高中奖概率，也不构成任何购彩建议。
 */
(function (root, factory) {
  var engine = root.LotteryEngine;
  if (!engine && typeof require === "function") {
    try { engine = require("./engine.js"); } catch (e) { engine = null; }
  }
  var api = factory(engine);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LotteryEnsemble = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (E) {
  "use strict";

  if (!E) throw new Error("LotteryEnsemble 需要先加载 LotteryEngine");

  var VERSION = "1.0.0";
  var VOTE_K = 3;
  var MAX_CANDIDATES = 15;

  /* ---------------- 基础工具 ---------------- */

  function range(min, max) { return E.range(min, max); }
  function pad(n) { return E.pad(n); }
  function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }
  function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
  function std(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / arr.length);
  }
  function zeroMap(pool) {
    var out = {};
    for (var i = 0; i < pool.length; i++) out[pool[i]] = 0;
    return out;
  }
  function sumMap(map) {
    var s = 0;
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) s += map[k];
    return s;
  }
  function isPrime(n) {
    if (n < 2) return false;
    for (var i = 2; i * i <= n; i++) if (n % i === 0) return false;
    return true;
  }
  function unique(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }
  function jaccard(a, b) {
    if (!a.length && !b.length) return 0;
    var sa = {}, sb = {}, inter = 0, union = 0;
    for (var i = 0; i < a.length; i++) sa[a[i]] = 1;
    for (var j = 0; j < b.length; j++) sb[b[j]] = 1;
    for (var k in sa) if (sa[k]) { union++; if (sb[k]) inter++; }
    for (var m in sb) if (sb[m] && !sa[m]) union++;
    return union ? inter / union : 0;
  }
  function normalize(items) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < items.length; i++) {
      var s = items[i].s;
      if (!isFinite(s)) s = 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    var span = max - min;
    var out = [];
    for (var j = 0; j < items.length; j++) {
      var v = isFinite(items[j].s) ? items[j].s : 0;
      out.push({ v: items[j].v, s: span > 1e-12 ? (v - min) / span : 0.5 });
    }
    return out;
  }
  function logFactTable(n) {
    var t = [0];
    for (var i = 1; i <= n; i++) t[i] = t[i - 1] + Math.log(i);
    return t;
  }
  function logChoose(logFact, n, k) {
    if (k < 0 || k > n) return -Infinity;
    return logFact[n] - logFact[k] - logFact[n - k];
  }
  function fourierAmp(series, period) {
    var re = 0, im = 0, n = series.length;
    for (var t = 0; t < n; t++) {
      var a = 2 * Math.PI * t / period;
      re += series[t] * Math.cos(a);
      im += series[t] * Math.sin(a);
    }
    return Math.sqrt(re * re + im * im) / Math.max(1, n);
  }
  function autocorr(series) {
    var n = series.length;
    if (n < 3) return 0;
    var m = mean(series), num = 0, den = 0;
    for (var i = 0; i < n; i++) den += (series[i] - m) * (series[i] - m);
    for (var j = 1; j < n; j++) num += (series[j] - m) * (series[j - 1] - m);
    return den > 1e-12 ? num / den : 0;
  }
  function linregSlope(series) {
    var n = Math.min(30, series.length);
    if (n < 3) return 0;
    var arr = series.slice(0, n).reverse(); // 旧 -> 新
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += i; sy += arr[i]; sxx += i * i; sxy += i * arr[i]; }
    var den = n * sxx - sx * sx;
    return den > 1e-12 ? (n * sxy - sx * sy) / den : 0;
  }
  function ema(series, alpha) {
    var arr = series.slice(0, 30).reverse();
    if (!arr.length) return 0;
    var v = arr[0];
    for (var i = 1; i < arr.length; i++) v = alpha * arr[i] + (1 - alpha) * v;
    return v;
  }
  function holt(series) {
    var arr = series.slice(0, 30).reverse();
    if (arr.length < 2) return arr[0] || 0;
    var level = arr[0], trend = arr[1] - arr[0];
    for (var i = 1; i < arr.length; i++) {
      var prev = level;
      level = 0.3 * arr[i] + 0.7 * (level + trend);
      trend = 0.1 * (level - prev) + 0.9 * trend;
    }
    return level + trend;
  }
  function kalman(series) {
    var arr = series.slice(0, 30).reverse();
    if (!arr.length) return 0;
    var x = arr[0], p = 1, q = 0.01, r = 0.1;
    for (var i = 1; i < arr.length; i++) {
      p += q;
      var k = p / (p + r);
      x = x + k * (arr[i] - x);
      p = (1 - k) * p;
    }
    return x;
  }
  function hurst(series) {
    var arr = series.slice(0, 60).reverse();
    if (arr.length < 10) return 0.5;
    var m = mean(arr), dev = 0, max = -Infinity, min = Infinity;
    for (var i = 0; i < arr.length; i++) {
      dev += arr[i] - m;
      if (dev > max) max = dev;
      if (dev < min) min = dev;
    }
    var R = max - min, S = std(arr);
    return S > 1e-12 ? Math.log(R / S) / Math.log(arr.length) : 0.5;
  }
  function runsZ(series) {
    var n = series.length;
    if (n < 5) return 0;
    var runs = 1, ones = 0;
    for (var i = 0; i < n; i++) { if (series[i]) ones++; if (i > 0 && series[i] !== series[i - 1]) runs++; }
    var zeros = n - ones;
    if (!ones || !zeros) return 0;
    var expected = 1 + 2 * ones * zeros / n;
    var variance = 2 * ones * zeros * (2 * ones * zeros - n) / (n * n * (n - 1));
    return variance > 0 ? (runs - expected) / Math.sqrt(variance) : 0;
  }
  function safeDiv(a, b, fallback) { return Math.abs(b) > 1e-12 ? a / b : (fallback || 0); }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  /* ---------------- 数据上下文 ---------------- */

  function targetValues(game, draw, target, position) {
    if (target === "digit") {
      var d = draw.digits || [];
      return d[position] == null ? [] : [d[position]];
    }
    if (target === "special") return E.specialNumbers(game, draw);
    return E.mainNumbers(game, draw);
  }

  function buildContext(game, draws, window, target, position, rng) {
    var recent = draws.slice(0, window);
    var values = [];
    for (var i = 0; i < recent.length; i++) values.push(targetValues(game, recent[i], target, position));
    var pool = target === "digit" ? range(0, 9) :
      target === "special" ? range(game.specialMin, game.specialMax) :
        range(game.mainMin, game.mainMax);
    var n = values.length;

    var counts = zeroMap(pool);
    var recentCounts = zeroMap(pool);
    var weightedCounts = zeroMap(pool);
    var lastSeen = zeroMap(pool);
    for (var p = 0; p < pool.length; p++) lastSeen[pool[p]] = -1;

    for (var t = 0; t < n; t++) {
      var arr = values[t];
      for (var j = 0; j < arr.length; j++) {
        var v = arr[j];
        if (counts[v] == null) continue;
        counts[v] += 1;
        weightedCounts[v] += Math.pow(0.97, t);
        if (t < 30) recentCounts[v] += 1;
        if (lastSeen[v] < 0) lastSeen[v] = t;
      }
    }

    var omit = zeroMap(pool);
    var series = {};
    var gapSum = zeroMap(pool);
    var gapCount = zeroMap(pool);
    var maxOmit = zeroMap(pool);
    for (var q = 0; q < pool.length; q++) {
      var val = pool[q];
      var s = [];
      var gap = 0;
      var seen = false;
      for (var d = 0; d < n; d++) {
        var hit = values[d].indexOf(val) >= 0;
        s.push(hit ? 1 : 0);
        if (hit) {
          if (seen) {
            gapSum[val] += gap;
            gapCount[val] += 1;
            if (gap > maxOmit[val]) maxOmit[val] = gap;
          }
          seen = true;
          gap = 0;
        } else {
          gap += 1;
        }
      }
      series[val] = s;
      omit[val] = lastSeen[val] < 0 ? n : lastSeen[val];
      if (omit[val] > maxOmit[val]) maxOmit[val] = omit[val];
    }

    var avgOmit = zeroMap(pool);
    for (var a = 0; a < pool.length; a++) {
      var pv = pool[a];
      avgOmit[pv] = gapCount[pv] ? gapSum[pv] / gapCount[pv] : n;
      if (avgOmit[pv] < 1) avgOmit[pv] = 1;
    }
    var omitArr = [];
    for (var oi = 0; oi < pool.length; oi++) omitArr.push(omit[pool[oi]]);
    var meanOmit = mean(omitArr);
    var stdOmit = std(omitArr);

    var countArr = [];
    for (var ci = 0; ci < pool.length; ci++) countArr.push(counts[pool[ci]]);
    var meanCount = mean(countArr);
    var stdCount = std(countArr);
    var expected = n / Math.max(1, pool.length);

    // 转移矩阵
    var transition = {};
    var transitionTotal = zeroMap(pool);
    for (var ti = 0; ti < pool.length; ti++) transition[pool[ti]] = zeroMap(pool);
    for (var tr = 0; tr < n - 1; tr++) {
      var cur = values[tr], nxt = values[tr + 1];
      for (var ca = 0; ca < cur.length; ca++) {
        var from = cur[ca];
        if (!transition[from]) continue;
        for (var cb = 0; cb < nxt.length; cb++) {
          var to = nxt[cb];
          if (transition[from][to] != null) transition[from][to] += 1;
        }
      }
    }
    for (var tt = 0; tt < pool.length; tt++) transitionTotal[pool[tt]] = sumMap(transition[pool[tt]]);

    // 二阶转移
    var triples = {};
    for (var t2 = 0; t2 < n - 2; t2++) {
      var prev2 = values[t2 + 2], cur2 = values[t2 + 1], next2 = values[t2];
      for (var pa = 0; pa < prev2.length; pa++) {
        for (var pc = 0; pc < cur2.length; pc++) {
          var key = prev2[pa] + "|" + cur2[pc];
          if (!triples[key]) triples[key] = zeroMap(pool);
          for (var nx = 0; nx < next2.length; nx++) {
            if (triples[key][next2[nx]] != null) triples[key][next2[nx]] += 1;
          }
        }
      }
    }

    // 共现矩阵
    var cooc = {};
    for (var co = 0; co < pool.length; co++) cooc[pool[co]] = zeroMap(pool);
    for (var cv = 0; cv < n; cv++) {
      var uniq = unique(values[cv]);
      for (var ua = 0; ua < uniq.length; ua++) {
        for (var ub = 0; ub < uniq.length; ub++) {
          if (uniq[ua] !== uniq[ub] && cooc[uniq[ua]] && cooc[uniq[ua]][uniq[ub]] != null) {
            cooc[uniq[ua]][uniq[ub]] += 1;
          }
        }
      }
    }

    // 基础形态
    var allValues = [];
    for (var av = 0; av < values.length; av++) allValues = allValues.concat(values[av]);
    var meanVal = mean(allValues);
    var stdVal = std(allValues);
    var minVal = allValues.length ? Math.min.apply(null, allValues) : 0;
    var maxVal = allValues.length ? Math.max.apply(null, allValues) : 0;

    var bigCut = game.id === "kl8" ? 40 : game.id === "dlt" ? 17 : game.id === "ssq" ? 16 : 4;
    var zoneCuts = game.id === "ssq" ? [11, 22, 33] :
      game.id === "dlt" ? [12, 24, 35] :
        game.id === "kl8" ? [20, 40, 60, 80] : [3, 6, 9];
    var zoneCount = zoneCuts.length;

    var odd = 0, big = 0, prime = 0, totalVals = 0;
    var road = zeroMap([0, 1, 2]);
    var tail = zeroMap(range(0, 9));
    var zone = zeroMap(range(0, zoneCount - 1));
    for (var tv = 0; tv < values.length; tv++) {
      for (var vv = 0; vv < values[tv].length; vv++) {
        var num = values[tv][vv];
        totalVals += 1;
        if (num % 2) odd += 1;
        if (num > bigCut) big += 1;
        if (isPrime(num)) prime += 1;
        road[num % 3] += 1;
        tail[num % 10] += 1;
        var z = 0;
        while (z < zoneCuts.length && num > zoneCuts[z]) z += 1;
        if (z >= zoneCount) z = zoneCount - 1;
        zone[z] += 1;
      }
    }
    var oddShare = totalVals ? odd / totalVals : 0.5;
    var bigShare = totalVals ? big / totalVals : 0.5;
    var primeShare = totalVals ? prime / totalVals : 0;
    var roadShare = {}, tailShare = {}, zoneShare = {};
    for (var rr = 0; rr < 3; rr++) roadShare[rr] = totalVals ? road[rr] / totalVals : 1 / 3;
    for (var tl = 0; tl < 10; tl++) tailShare[tl] = totalVals ? tail[tl] / totalVals : 0.1;
    for (var zz = 0; zz < zoneCount; zz++) zoneShare[zz] = totalVals ? zone[zz] / totalVals : 1 / zoneCount;
    for (var zi = 0; zi < pool.length; zi++) {
      var zn = 0;
      while (zn < zoneCuts.length && pool[zi] > zoneCuts[zn]) zn += 1;
      if (zn >= zoneCount) zn = zoneCount - 1;
      zoneShare[pool[zi]] = zoneShare[zn] || 0;
    }

    // 条件概率
    var conditionalSelf = zeroMap(pool);
    var pNext = zeroMap(pool);
    for (var cs = 0; cs < pool.length; cs++) {
      var cval = pool[cs];
      conditionalSelf[cval] = transitionTotal[cval] > 0 ? transition[cval][cval] / transitionTotal[cval] : 0;
      pNext[cval] = n ? counts[cval] / n : 0;
    }

    // KNN：找与最新一期最相似的历史期，统计其次期号码
    var knnScore = zeroMap(pool);
    var last = values[0] || [];
    if (target === "digit") {
      var lastDigit = last.length ? last[0] : null;
      if (lastDigit != null) {
        var hitIdx = [];
        for (var ki = 2; ki < n - 1; ki++) {
          if (values[ki][0] === lastDigit) hitIdx.push(ki);
          if (hitIdx.length >= 20) break;
        }
        for (var kj = 0; kj < hitIdx.length; kj++) {
          var nxtDigits = values[hitIdx[kj] - 1];
          if (nxtDigits.length) knnScore[nxtDigits[0]] += 1;
        }
      }
    } else {
      var sims = [];
      for (var ks = 2; ks < n - 1; ks++) sims.push({ i: ks, sim: jaccard(values[ks], last) });
      sims.sort(function (x, y) { return y.sim - x.sim; });
      for (var kk = 0; kk < Math.min(12, sims.length); kk++) {
        var nexts = values[sims[kk].i - 1];
        for (var kn = 0; kn < nexts.length; kn++) {
          if (knnScore[nexts[kn]] != null) knnScore[nexts[kn]] += 1;
        }
      }
    }

    // 邻号 / 连号 / 尾数
    var neighborFreq = zeroMap(pool);
    var tailFreq = zeroMap(pool);
    for (var nf = 0; nf < values.length; nf++) {
      var arr2 = unique(values[nf]);
      for (var na = 0; na < arr2.length; na++) {
        var nv = arr2[na];
        if (neighborFreq[nv] == null) continue;
        if (arr2.indexOf(nv - 1) >= 0 || arr2.indexOf(nv + 1) >= 0) neighborFreq[nv] += 1;
        tailFreq[nv % 10] = (tailFreq[nv % 10] || 0) + 1;
      }
    }

    // 蒙特卡洛与 Bootstrap
    var mcScore = zeroMap(pool);
    var bsScore = zeroMap(pool);
    var totalWeight = sumMap(weightedCounts);
    if (totalWeight > 0) {
      for (var mc = 0; mc < 600; mc++) {
        var r = rng() * totalWeight, acc = 0, pick = pool[0];
        for (var mi = 0; mi < pool.length; mi++) {
          acc += weightedCounts[pool[mi]];
          if (r <= acc) { pick = pool[mi]; break; }
        }
        mcScore[pick] += 1;
      }
    }
    if (n > 0) {
      for (var bs = 0; bs < 600; bs++) {
        var idx = Math.floor(rng() * n);
        var bv = values[idx];
        if (bv.length) {
          var chosen = bv[Math.floor(rng() * bv.length)];
          if (bsScore[chosen] != null) bsScore[chosen] += 1;
        }
      }
    }

    var logFact = logFactTable(Math.max(2, n + 1));
    var lastTwo = [];
    if (values.length >= 2) {
      for (var l1 = 0; l1 < values[0].length; l1++) {
        for (var l2 = 0; l2 < values[1].length; l2++) lastTwo.push(values[1][l2] + "|" + values[0][l1]);
      }
    }

    return {
      game: game, target: target, position: position, recent: recent, values: values,
      pool: pool, n: n, counts: counts, recentCounts: recentCounts, weightedCounts: weightedCounts,
      omit: omit, avgOmit: avgOmit, maxOmit: maxOmit, meanOmit: meanOmit, stdOmit: stdOmit,
      meanCount: meanCount, stdCount: stdCount, expected: expected,
      series: series, transition: transition, transitionTotal: transitionTotal, triples: triples,
      cooc: cooc, conditionalSelf: conditionalSelf, pNext: pNext, knnScore: knnScore,
      neighborFreq: neighborFreq, tailFreq: tailFreq,
      meanVal: meanVal, stdVal: stdVal, minVal: minVal, maxVal: maxVal,
      bigCut: bigCut, zoneCuts: zoneCuts, zoneCount: zoneCount,
      oddShare: oddShare, bigShare: bigShare, primeShare: primeShare,
      roadShare: roadShare, tailShare: tailShare, zoneShare: zoneShare,
      mcScore: mcScore, bsScore: bsScore, logFact: logFact, lastTwo: lastTwo,
      last: last, prev: values[1] || [],
      drawSize: target === "special" ? game.specialCount : target === "digit" ? 1 : game.mainCount,
    };
  }

  /* ---------------- 60 个模型 ---------------- */

  var MODELS = [];

  function model(id, name, category, formula, score) {
    MODELS.push({ id: id, name: name, category: category, formula: formula, score: score, weight: 1 });
  }

  // 1. 频率与贝叶斯（10）
  model("freq", "原始频率", "频率与贝叶斯", "P(v)=count(v)/N", function (c, v) {
    return safeDiv(c.counts[v], c.n);
  });
  model("expfreq", "指数加权频率", "频率与贝叶斯", "Σ 0.97^t · I(v_t=v)", function (c, v) {
    return c.weightedCounts[v];
  });
  model("laplace", "拉普拉斯平滑", "频率与贝叶斯", "(count+1)/(N+K)", function (c, v) {
    return (c.counts[v] + 1) / (c.n + c.pool.length);
  });
  model("beta", "Beta-Binomial 后验", "频率与贝叶斯", "(count+α)/(N+α+β), α=β=1", function (c, v) {
    return (c.counts[v] + 1) / (c.n + 2);
  });
  model("bayesfactor", "贝叶斯因子", "频率与贝叶斯", "(count+0.5)/(N/K+0.5)", function (c, v) {
    return (c.counts[v] + 0.5) / (c.expected + 0.5);
  });
  model("chi", "卡方标准化残差", "频率与贝叶斯", "(O-E)/√E", function (c, v) {
    return safeDiv(c.counts[v] - c.expected, Math.sqrt(Math.max(1e-9, c.expected)));
  });
  model("zscore", "频率 Z-Score", "频率与贝叶斯", "(count-μ)/σ", function (c, v) {
    return safeDiv(c.counts[v] - c.meanCount, c.stdCount, 0);
  });
  model("tfidf", "TF-IDF 热度", "频率与贝叶斯", "P_recent/P_all", function (c, v) {
    var recentP = safeDiv(c.recentCounts[v], Math.min(30, c.n));
    var allP = safeDiv(c.counts[v], c.n);
    return safeDiv(recentP + 0.001, allP + 0.001, 1);
  });
  model("entropy", "信息熵", "频率与贝叶斯", "-p·log2(p)", function (c, v) {
    var p = Math.max(1e-9, safeDiv(c.counts[v], c.n));
    return -p * Math.log(p) / Math.LN2;
  });
  model("infogain", "信息增益", "频率与贝叶斯", "P(v_next|v_now)-P(v_next)", function (c, v) {
    return c.conditionalSelf[v] - c.pNext[v];
  });

  // 2. 遗漏与生存（10）
  model("omit", "当前遗漏", "遗漏与生存", "omit(v)", function (c, v) {
    return c.omit[v];
  });
  model("avgomit", "平均遗漏", "遗漏与生存", "mean(gap)", function (c, v) {
    return c.avgOmit[v];
  });
  model("maxomit", "最大遗漏", "遗漏与生存", "max(gap)", function (c, v) {
    return c.maxOmit[v];
  });
  model("geometric", "几何回补概率", "遗漏与生存", "1-(1-p)^(omit+1)", function (c, v) {
    var p = Math.max(0.001, Math.min(0.999, safeDiv(c.counts[v], c.n, 1 / c.pool.length)));
    return 1 - Math.pow(1 - p, c.omit[v] + 1);
  });
  model("hazard", "风险率", "遗漏与生存", "1/(avgOmit-omit+1)", function (c, v) {
    return 1 / Math.max(1, c.avgOmit[v] - c.omit[v] + 1);
  });
  model("survival", "生存函数", "遗漏与生存", "exp(-omit/avgOmit)", function (c, v) {
    return Math.exp(-c.omit[v] / Math.max(1, c.avgOmit[v]));
  });
  model("omitz", "遗漏 Z-Score", "遗漏与生存", "(omit-μ)/σ", function (c, v) {
    return safeDiv(c.omit[v] - c.meanOmit, c.stdOmit, 0);
  });
  model("overdue", "回补紧迫度", "遗漏与生存", "omit/avgOmit", function (c, v) {
    return safeDiv(c.omit[v], Math.max(1, c.avgOmit[v]), 1);
  });
  model("coldrev", "冷号反转", "遗漏与生存", "(1-p)·omit/avgOmit", function (c, v) {
    var p = safeDiv(c.counts[v], c.n);
    return (1 - p) * safeDiv(c.omit[v], Math.max(1, c.avgOmit[v]), 1);
  });
  model("omitdecay", "遗漏衰减", "遗漏与生存", "exp(-omit/N)", function (c, v) {
    return Math.exp(-c.omit[v] / Math.max(1, c.n));
  });

  // 3. 转移与关联（10）
  model("markov1", "一阶马尔可夫", "转移与关联", "P(v|last)=T(last,v)", function (c, v) {
    var total = 0, hits = 0;
    for (var i = 0; i < c.last.length; i++) {
      var from = c.last[i];
      if (c.transition[from]) {
        total += c.transitionTotal[from];
        hits += c.transition[from][v] || 0;
      }
    }
    return safeDiv(hits, total);
  });
  model("markov2", "二阶马尔可夫", "转移与关联", "P(v|prev,last)=T2(prev,last,v)", function (c, v) {
    var total = 0, hits = 0;
    for (var i = 0; i < c.lastTwo.length; i++) {
      var map = c.triples[c.lastTwo[i]];
      if (map) { total += sumMap(map); hits += map[v] || 0; }
    }
    return safeDiv(hits, total);
  });
  model("repeat", "重号概率", "转移与关联", "I(v∈上期)·P(v|v)", function (c, v) {
    return c.last.indexOf(v) >= 0 ? c.conditionalSelf[v] : 0;
  });
  model("nonrepeat", "非重号概率", "转移与关联", "I(v∉上期)·P(v)", function (c, v) {
    return c.last.indexOf(v) < 0 ? c.pNext[v] : 0;
  });
  model("assoc", "关联规则置信度", "转移与关联", "conf(v→last)", function (c, v) {
    if (c.target === "digit") return c.conditionalSelf[v];
    var total = 0, hits = 0;
    for (var i = 0; i < c.last.length; i++) {
      var b = c.last[i];
      total += c.counts[b] || 0;
      hits += (c.cooc[v] && c.cooc[v][b]) || 0;
    }
    return safeDiv(hits, total);
  });
  model("collab", "协同过滤", "转移与关联", "cos(v,last)", function (c, v) {
    if (c.target === "digit") return c.conditionalSelf[v];
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < c.last.length; i++) {
      var b = c.last[i];
      var x = (c.cooc[v] && c.cooc[v][b]) || 0;
      dot += x;
      na += x * x;
      nb += (c.counts[b] || 0) * (c.counts[b] || 0);
    }
    return safeDiv(dot, Math.sqrt(na * nb + 1e-12));
  });
  model("knn", "KNN 相似期", "转移与关联", "Σ sim(history,last)·I(v∈next)", function (c, v) {
    return c.knnScore[v];
  });
  model("mutual", "互信息", "转移与关联", "Σ P(v,b)log(P(v,b)/(P(v)P(b)))", function (c, v) {
    if (c.target === "digit") return c.conditionalSelf[v] - c.pNext[v];
    var total = 0;
    var pv = safeDiv(c.counts[v], c.n);
    for (var i = 0; i < c.last.length; i++) {
      var b = c.last[i];
      var pvb = safeDiv((c.cooc[v] && c.cooc[v][b]) || 0, c.n);
      var pb = safeDiv(c.counts[b], c.n);
      if (pvb > 0 && pv > 0 && pb > 0) total += pvb * Math.log(pvb / (pv * pb));
    }
    return total;
  });
  model("neighbor", "邻号频率", "转移与关联", "I(|v-last|=1) 或 count(adjacent)/count(v)", function (c, v) {
    if (c.target === "digit") return c.last.length && Math.abs(v - c.last[0]) === 1 ? 1 : 0;
    return safeDiv(c.neighborFreq[v], Math.max(1, c.counts[v]));
  });
  model("tail", "尾数关联", "转移与关联", "P(tail(v)|tail(last))", function (c, v) {
    return c.tailFreq[v % 10] || 0;
  });

  // 4. 形态与组合（10）
  model("sumnormal", "和值正态", "形态与组合", "exp(-(v-μ)²/2σ²)", function (c, v) {
    return Math.exp(-Math.pow(v - c.meanVal, 2) / (2 * Math.pow(c.stdVal || 1, 2)));
  });
  model("oddb", "奇偶平衡", "形态与组合", "1-|奇偶占比-候选奇偶|", function (c, v) {
    return 1 - Math.abs(c.oddShare - (v % 2 ? 1 : 0));
  });
  model("bigb", "大小平衡", "形态与组合", "1-|大数占比-候选大小|", function (c, v) {
    return 1 - Math.abs(c.bigShare - (v > c.bigCut ? 1 : 0));
  });
  model("zoneb", "区间平衡", "形态与组合", "1-|区间占比-1/K|", function (c, v) {
    return 1 - Math.abs((c.zoneShare[v] || 0) - 1 / c.zoneCount);
  });
  model("ac", "AC 值离散度", "形态与组合", "|v-μ|/σ", function (c, v) {
    return safeDiv(Math.abs(v - c.meanVal), c.stdVal || 1);
  });
  model("span", "跨度位置", "形态与组合", "(v-min)/(max-min)", function (c, v) {
    return safeDiv(v - c.minVal, Math.max(1, c.maxVal - c.minVal));
  });
  model("primeb", "质合平衡", "形态与组合", "1-|质数占比-候选质合|", function (c, v) {
    return 1 - Math.abs(c.primeShare - (isPrime(v) ? 1 : 0));
  });
  model("road", "012 路", "形态与组合", "roadShare[v mod 3]", function (c, v) {
    return c.roadShare[v % 3] || 0;
  });
  model("tailb", "尾数分布", "形态与组合", "tailShare[v mod 10]", function (c, v) {
    return c.tailShare[v % 10] || 0;
  });
  model("consec", "连号倾向", "形态与组合", "I(|v-last|≤1) 或 count(adjacent)/count(v)", function (c, v) {
    if (c.target === "digit") return c.last.length && Math.abs(v - c.last[0]) <= 1 ? 1 : 0;
    return safeDiv(c.neighborFreq[v], Math.max(1, c.counts[v]));
  });

  // 5. 时间序列与信号（10）
  model("ma5", "5 期移动平均", "时间序列", "mean(series[0..4])", function (c, v) {
    return mean(c.series[v].slice(0, 5));
  });
  model("ema", "指数平滑", "时间序列", "EMA(series, α=0.3)", function (c, v) {
    return ema(c.series[v], 0.3);
  });
  model("linreg", "线性回归斜率", "时间序列", "slope(series, 30)", function (c, v) {
    return linregSlope(c.series[v]);
  });
  model("ar1", "AR(1) 预测", "时间序列", "μ+φ(x_t-μ)", function (c, v) {
    var phi = autocorr(c.series[v]);
    var mu = mean(c.series[v]);
    var last = c.series[v][0] || 0;
    return mu + phi * (last - mu);
  });
  model("holt", "Holt 双指数", "时间序列", "level+trend", function (c, v) {
    return holt(c.series[v]);
  });
  model("kalman", "卡尔曼滤波", "时间序列", "K(x_t-μ)", function (c, v) {
    return kalman(c.series[v]);
  });
  model("fourier", "傅里叶周期", "时间序列", "|FFT(series, 7)|/N", function (c, v) {
    return fourierAmp(c.series[v], 7);
  });
  model("autocorr", "自相关", "时间序列", "corr(x_t,x_{t-1})", function (c, v) {
    return autocorr(c.series[v]);
  });
  model("hurst", "Hurst 指数", "时间序列", "log(R/S)/log(N)", function (c, v) {
    return hurst(c.series[v]);
  });
  model("runs", "游程检验", "时间序列", "|runs-E[runs]|/√Var", function (c, v) {
    return Math.abs(runsZ(c.series[v]));
  });

  // 6. 分布与优化（10）
  model("binomial", "二项分布", "分布与优化", "C(N,k)p^k(1-p)^(N-k)", function (c, v) {
    var k = c.counts[v];
    var p = Math.max(1e-9, Math.min(1 - 1e-9, c.drawSize / c.pool.length));
    var logp = logChoose(c.logFact, c.n, k) + k * Math.log(p) + (c.n - k) * Math.log(1 - p);
    return Math.exp(logp);
  });
  model("poisson", "泊松分布", "分布与优化", "e^-λ λ^k/k!", function (c, v) {
    var k = c.counts[v];
    var lambda = Math.max(1e-9, c.n * c.drawSize / c.pool.length);
    var logp = -lambda + (k > 0 ? k * Math.log(lambda) : 0) - c.logFact[k];
    return Math.exp(logp);
  });
  model("hyper", "超几何入选概率", "分布与优化", "(m/K)·(count/E)", function (c, v) {
    var K = c.pool.length;
    var m = Math.max(1, c.drawSize);
    if (m >= K) return 1;
    var logp = Math.log(m / K); // log(1 - C(K-1,m)/C(K,m)) 的稳定近似
    var base = Math.exp(logp);
    return base * safeDiv(c.counts[v], c.expected, 1);
  });
  model("multinomial", "多项分布", "分布与优化", "k·log(k/(N·p))", function (c, v) {
    var k = c.counts[v];
    if (k <= 0) return 0;
    return k * Math.log(k / Math.max(1e-9, c.n * c.drawSize / c.pool.length));
  });
  model("dirichlet", "Dirichlet 后验", "分布与优化", "(k+α)/(N+αK), α=0.5", function (c, v) {
    return (c.counts[v] + 0.5) / (c.n + 0.5 * c.pool.length);
  });
  model("montecarlo", "蒙特卡洛", "分布与优化", "simulated P(v)", function (c, v) {
    return c.mcScore[v];
  });
  model("bootstrap", "Bootstrap", "分布与优化", "resampled P(v)", function (c, v) {
    return c.bsScore[v];
  });
  model("genetic", "遗传算法适应度", "分布与优化", "0.4f+0.3r+0.2o+0.1b", function (c, v) {
    var f = safeDiv(c.counts[v], c.n);
    var r = safeDiv(c.recentCounts[v], Math.min(30, c.n));
    var o = safeDiv(c.omit[v], Math.max(1, c.avgOmit[v]));
    var b = 1 - Math.abs(c.oddShare - (v % 2 ? 1 : 0));
    return 0.4 * f + 0.3 * r + 0.2 * o + 0.1 * b;
  });
  model("annealing", "模拟退火", "分布与优化", "exp(-|v-v*|/T)", function (c, v) {
    var best = c.pool[0], bestCount = -1;
    for (var i = 0; i < c.pool.length; i++) {
      if (c.counts[c.pool[i]] > bestCount) { bestCount = c.counts[c.pool[i]]; best = c.pool[i]; }
    }
    var T = Math.max(1, c.stdCount || 1);
    return Math.exp(-Math.abs(v - best) / T);
  });
  model("topsis", "TOPSIS", "分布与优化", "D-/(D++D-)", function (c, v) {
    var f = safeDiv(c.counts[v], c.n);
    var r = safeDiv(c.recentCounts[v], Math.min(30, c.n));
    var o = Math.min(1, safeDiv(c.omit[v], Math.max(1, c.n)));
    var dp = Math.sqrt(Math.pow(1 - f, 2) + Math.pow(1 - r, 2) + Math.pow(1 - o, 2));
    var dm = Math.sqrt(f * f + r * r + o * o);
    return safeDiv(dm, dp + dm, 0.5);
  });
  model("grey", "灰色关联度", "分布与优化", "1/(1+Σ|x-1|)", function (c, v) {
    var f = safeDiv(c.counts[v], c.n);
    var r = safeDiv(c.recentCounts[v], Math.min(30, c.n));
    var o = Math.min(1, safeDiv(c.omit[v], Math.max(1, c.n)));
    return 1 / (1 + Math.abs(1 - f) + Math.abs(1 - r) + Math.abs(1 - o));
  });

  /* ---------------- 评估与投票 ---------------- */

  function evaluatePool(ctx) {
    var votes = zeroMap(ctx.pool);
    var scores = zeroMap(ctx.pool);
    var models = [];
    var voteK = Math.min(VOTE_K, ctx.pool.length);

    for (var i = 0; i < MODELS.length; i++) {
      var m = MODELS[i];
      var raw = [];
      for (var p = 0; p < ctx.pool.length; p++) {
        var v = ctx.pool[p];
        var s = 0;
        try { s = m.score(ctx, v); } catch (e) { s = 0; }
        if (!isFinite(s)) s = 0;
        raw.push({ v: v, s: s });
      }
      var norm = normalize(raw);
      norm.sort(function (a, b) { return b.s - a.s || a.v - b.v; });
      var top = norm.slice(0, voteK);
      for (var t = 0; t < top.length; t++) {
        votes[top[t].v] += 1;
        scores[top[t].v] += top[t].s;
      }
      models.push({
        id: m.id, name: m.name, category: m.category, formula: m.formula,
        weight: m.weight, top: top.map(function (x) { return x.v; }),
      });
    }

    var sorted = [];
    for (var q = 0; q < ctx.pool.length; q++) {
      var val = ctx.pool[q];
      sorted.push({ n: val, votes: votes[val], score: scores[val] });
    }
    sorted.sort(function (a, b) {
      return b.votes - a.votes || b.score - a.score || a.n - b.n;
    });
    return { votes: votes, scores: scores, sorted: sorted, models: models };
  }

  /* ---------------- 约束与组合 ---------------- */

  function zoneCounts(nums, cuts) {
    var zones = [];
    for (var i = 0; i < cuts.length; i++) zones.push(0);
    for (var j = 0; j < nums.length; j++) {
      var n = nums[j], z = 0;
      while (z < cuts.length && n > cuts[z]) z += 1;
      if (z >= zones.length) z = zones.length - 1;
      zones[z] += 1;
    }
    return zones;
  }
  function consecutivePairs(nums) {
    var n = 0;
    for (var i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] === 1) n += 1;
    return n;
  }
  function validateCombination(gameId, nums) {
    var s = sum(nums);
    var odd = 0;
    for (var i = 0; i < nums.length; i++) if (nums[i] % 2) odd += 1;
    if (gameId === "ssq") {
      var z = zoneCounts(nums, [11, 22, 33]);
      return s >= 78 && s <= 142 && odd >= 2 && odd <= 4 &&
        z[0] >= 1 && z[1] >= 1 && z[2] >= 1 && consecutivePairs(nums) <= 2;
    }
    if (gameId === "dlt") {
      var zd = zoneCounts(nums, [12, 24, 35]);
      return s >= 62 && s <= 128 && odd >= 2 && odd <= 3 &&
        zd[0] >= 1 && zd[1] >= 1 && zd[2] >= 1 && consecutivePairs(nums) <= 2;
    }
    if (gameId === "kl8") {
      var zk = zoneCounts(nums, [20, 40, 60, 80]);
      return s >= 325 && s <= 485 && odd >= 3 && odd <= 7 &&
        zk[0] >= 1 && zk[1] >= 1 && zk[2] >= 1 && zk[3] >= 1 &&
        zk.every(function (x) { return x <= 4; });
    }
    return true;
  }

  function countDifferent(a, b) {
    var diff = 0;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) diff += 1;
    return diff;
  }

  function chooseCombination(sorted, k, gameId, excludeKey, rng, firstPrimary, minDiff) {
    var candidates = sorted.slice(0, Math.min(sorted.length, Math.max(MAX_CANDIDATES, k + 9)));
    var best = [];
    var chosen = [];

    function rec(start, voteSum, scoreSum) {
      if (chosen.length === k) {
        var nums = chosen.slice().sort(function (a, b) { return a - b; });
        var key = nums.join(",");
        if (key === excludeKey) return;
        if (firstPrimary && minDiff && countDifferent(nums, firstPrimary) < minDiff) return;
        if (validateCombination(gameId, nums)) {
          best.push({ primary: nums, key: key, voteSum: voteSum, scoreSum: scoreSum });
        }
        return;
      }
      for (var i = start; i < candidates.length; i++) {
        if (candidates.length - i < k - chosen.length) break;
        chosen.push(candidates[i].n);
        rec(i + 1, voteSum + candidates[i].votes, scoreSum + candidates[i].score);
        chosen.pop();
      }
    }
    rec(0, 0, 0);
    best.sort(function (a, b) { return b.voteSum - a.voteSum || b.scoreSum - a.scoreSum; });
    if (best.length) return best[0];

    // 兜底：从票数靠前的号码里随机找合法组合
    var pool = sorted.slice(0, Math.min(sorted.length, 24)).map(function (x) { return x.n; });
    for (var attempt = 0; attempt < 2000; attempt++) {
      var shuffled = E.shuffle(pool, rng).slice(0, k).sort(function (a, b) { return a - b; });
      var key2 = shuffled.join(",");
      if (key2 === excludeKey) continue;
      if (firstPrimary && minDiff && countDifferent(shuffled, firstPrimary) < minDiff) continue;
      if (validateCombination(gameId, shuffled)) {
        var vs = 0;
        for (var q = 0; q < shuffled.length; q++) {
          for (var w = 0; w < sorted.length; w++) if (sorted[w].n === shuffled[q]) { vs += sorted[w].votes; break; }
        }
        return { primary: shuffled, key: key2, voteSum: vs, scoreSum: 0 };
      }
    }
    return { primary: candidates.slice(0, k).map(function (x) { return x.n; }), key: "", voteSum: 0, scoreSum: 0 };
  }

  function topK(sorted, k) {
    return sorted.slice(0, k).map(function (x) { return x.n; }).sort(function (a, b) { return a - b; });
  }
  function nextK(sorted, k, exclude) {
    var used = {}, out = [];
    for (var e = 0; e < exclude.length; e++) used[exclude[e]] = 1;
    for (var i = 0; i < sorted.length && out.length < k; i++) {
      if (!used[sorted[i].n]) { out.push(sorted[i].n); used[sorted[i].n] = 1; }
    }
    if (out.length < k) {
      for (var j = 0; j < sorted.length && out.length < k; j++) {
        if (out.indexOf(sorted[j].n) < 0) out.push(sorted[j].n);
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function voteSumOf(sorted, nums) {
    var map = {};
    for (var i = 0; i < sorted.length; i++) map[sorted[i].n] = sorted[i].votes;
    var s = 0;
    for (var j = 0; j < nums.length; j++) s += map[nums[j]] || 0;
    return s;
  }

  /* ---------------- 推荐入口 ---------------- */

  function recommend(gameId, draws, opts) {
    var game = E.GAMES[gameId];
    if (!game) throw new Error("unknown game: " + gameId);
    opts = opts || {};
    var window = opts.window || 100;
    var rng = E.makeRng(opts.seed);
    var modelCount = MODELS.length;
    var sets = [];
    var mainVotes = [];
    var specialVotes = [];
    var positions = [];
    var modelsForUI = [];

    if (game.kind === "digits") {
      var posEvals = [];
      for (var p = 0; p < game.digits; p++) {
        var ctx = buildContext(game, draws || [], window, "digit", p, rng);
        var ev = evaluatePool(ctx);
        posEvals.push({ ctx: ctx, ev: ev });
        positions.push({
          index: p,
          name: game.positions[p],
          votes: ev.sorted,
          selected: ev.sorted[0] ? ev.sorted[0].n : 0,
        });
      }

      var set1 = [], set2 = [], v1 = 0, v2 = 0;
      for (var pi = 0; pi < posEvals.length; pi++) {
        var sorted = posEvals[pi].ev.sorted;
        var d1 = sorted[0] ? sorted[0].n : 0;
        var d2 = null;
        for (var di = 1; di < sorted.length; di++) {
          if (sorted[di].n !== d1) { d2 = sorted[di].n; break; }
        }
        if (d2 == null) d2 = (d1 + 1) % 10;
        set1.push(d1);
        set2.push(d2);
        v1 += sorted[0] ? sorted[0].votes : 0;
        var vv = 0;
        for (var sj = 0; sj < sorted.length; sj++) if (sorted[sj].n === d2) { vv = sorted[sj].votes; break; }
        v2 += vv;
      }
      if (set1.every(function (d) { return d === set1[0]; })) {
        set1[set1.length - 1] = (set1[0] + 1) % 10;
      }
      if (set2.join("") === set1.join("")) {
        set2[set2.length - 1] = (set2[set2.length - 1] + 1) % 10;
      }
      sets.push({ label: "最终一注", primary: set1, special: [], voteSum: v1 });
      sets.push({ label: "备选一注", primary: set2, special: [], voteSum: v2 });
      for (var ps = 0; ps < positions.length; ps++) {
        positions[ps].selected = set1[ps];
        positions[ps].selected2 = set2[ps];
      }

      for (var mi = 0; mi < posEvals[0].ev.models.length; mi++) {
        var base = posEvals[0].ev.models[mi];
        var byPos = [];
        for (var pp = 0; pp < posEvals.length; pp++) {
          var found = null;
          for (var mm = 0; mm < posEvals[pp].ev.models.length; mm++) {
            if (posEvals[pp].ev.models[mm].id === base.id) { found = posEvals[pp].ev.models[mm]; break; }
          }
          byPos.push(found ? found.top : []);
        }
        modelsForUI.push({
          id: base.id, name: base.name, category: base.category, formula: base.formula,
          weight: base.weight, top: byPos[0] || [], topByPosition: byPos,
        });
      }
    } else {
      var mainCtx = buildContext(game, draws || [], window, "main", -1, rng);
      var mainEval = evaluatePool(mainCtx);
      var specialCtx = game.specialCount ? buildContext(game, draws || [], window, "special", -1, rng) : null;
      var specialEval = specialCtx ? evaluatePool(specialCtx) : null;

      var first = chooseCombination(mainEval.sorted, game.mainCount, gameId, null, rng);
      var second = chooseCombination(mainEval.sorted, game.mainCount, gameId, first.key, rng, first.primary, 2);

      var sp1 = specialEval ? topK(specialEval.sorted, game.specialCount) : [];
      var sp2 = specialEval ? nextK(specialEval.sorted, game.specialCount, sp1) : [];
      var sp1Sum = specialEval ? voteSumOf(specialEval.sorted, sp1) : 0;
      var sp2Sum = specialEval ? voteSumOf(specialEval.sorted, sp2) : 0;

      sets.push({ label: "最终一注", primary: first.primary, special: sp1, voteSum: first.voteSum + sp1Sum });
      sets.push({ label: "备选一注", primary: second.primary, special: sp2, voteSum: second.voteSum + sp2Sum });

      mainVotes = mainEval.sorted;
      specialVotes = specialEval ? specialEval.sorted : [];

      var specialTopById = {};
      if (specialEval) {
        for (var sm = 0; sm < specialEval.models.length; sm++) {
          specialTopById[specialEval.models[sm].id] = specialEval.models[sm].top;
        }
      }
      for (var mj = 0; mj < mainEval.models.length; mj++) {
        var mmodel = mainEval.models[mj];
        modelsForUI.push({
          id: mmodel.id, name: mmodel.name, category: mmodel.category, formula: mmodel.formula,
          weight: mmodel.weight, top: mmodel.top, specialTop: specialTopById[mmodel.id] || [],
        });
      }
    }

    return {
      version: VERSION,
      gameId: gameId,
      window: window,
      modelCount: modelCount,
      voteK: VOTE_K,
      sets: sets,
      mainVotes: mainVotes,
      specialVotes: specialVotes,
      positions: positions,
      models: modelsForUI,
      generatedAt: Date.now(),
    };
  }

  return {
    VERSION: VERSION,
    VOTE_K: VOTE_K,
    MODELS: MODELS,
    recommend: recommend,
  };
});
