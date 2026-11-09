#!/usr/bin/env python3
"""抓取五种数字彩的官方开奖数据，合并写入 data/lottery.json。

数据源（优先官方公开接口，海外网络不可用时回退到 500.com）：
  福彩：双色球 ssq / 福彩3D 3d / 快乐8 kl8  ->  www.cwl.gov.cn
  体彩：大乐透 dlt / 排列5 p5               ->  webapi.sporttery.cn
  备用：https://datachart.500.com/         ->  GitHub Actions 海外环境使用

脚本只使用 Python 标准库，可在 GitHub Actions 中直接运行。
"""
from __future__ import annotations

import html as html_lib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "lottery.json"
MAX_DRAWS = 150
CST = timezone(timedelta(hours=8))
FIVE_HUNDRED = "https://datachart.500.com"
SOURCE_MODE = os.environ.get("LOTTERY_SOURCE", "auto").strip().lower()

# Windows 控制台默认 GBK，统一改为 UTF-8，避免中文/符号输出报错
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

UA_DESKTOP = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
UA_MOBILE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

GAME_META = {
    "ssq": {"name": "双色球", "source": "cwl", "param": "ssq"},
    "dlt": {"name": "大乐透", "source": "sporttery", "param": "85"},
    "fc3d": {"name": "福彩3D", "source": "cwl", "param": "3d"},
    "p5": {"name": "排列5", "source": "sporttery", "param": "350133"},
    "kl8": {"name": "快乐8", "source": "cwl", "param": "kl8"},
}


def log(msg: str) -> None:
    print(msg, flush=True)


def http_json(url: str, headers: dict[str, str], retries: int = 3, timeout: int = 25):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8-sig"))
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log(f"  ! 请求失败（{attempt}/{retries}）：{exc}")
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"请求失败：{url}") from last_err


def cwl_headers() -> dict[str, str]:
    return {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://www.cwl.gov.cn/",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "X-Requested-With": "XMLHttpRequest",
    }


def sporttery_headers() -> dict[str, str]:
    return {
        "User-Agent": UA_MOBILE,
        "Referer": "https://static.sporttery.cn/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }


def five_headers() -> dict[str, str]:
    return {
        "User-Agent": UA_DESKTOP,
        "Referer": "https://datachart.500.com/",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }


def http_text(url: str, headers: dict[str, str], retries: int = 3, timeout: int = 25) -> str:
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode("gb18030", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            log(f"  ! 请求失败（{attempt}/{retries}）：{exc}")
            if attempt < retries:
                time.sleep(2 * attempt)
    raise RuntimeError(f"请求失败：{url}") from last_err


def fetch_cwl(game_id: str) -> list[dict]:
    param = GAME_META[game_id]["param"]
    url = (
        "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
        f"?name={param}&issueCount={MAX_DRAWS}&pageNo=1&pageSize={MAX_DRAWS}"
    )
    data = http_json(url, cwl_headers())
    items = data.get("result") or []
    if not items:
        raise RuntimeError(f"{game_id}: 福彩接口返回空数据")

    draws: list[dict] = []
    for item in items:
        try:
            issue = str(item.get("code", "")).strip()
            date = str(item.get("date", "")).split("(")[0].strip()
            red = [int(x) for x in str(item.get("red", "")).split(",") if x.strip() != ""]
            blue = [int(x) for x in str(item.get("blue", "")).split(",") if x.strip() != ""]
            if not issue or not date:
                continue

            if game_id == "ssq":
                if len(red) != 6 or len(blue) != 1:
                    continue
                if not all(1 <= n <= 33 for n in red) or not (1 <= blue[0] <= 16):
                    continue
                draw = {"issue": issue, "date": date, "red": sorted(red), "blue": blue}
            elif game_id == "fc3d":
                if len(red) != 3 or not all(0 <= n <= 9 for n in red):
                    continue
                draw = {"issue": issue, "date": date, "digits": red}
            elif game_id == "kl8":
                if len(red) != 20 or not all(1 <= n <= 80 for n in red):
                    continue
                draw = {"issue": issue, "date": date, "nums": sorted(red)}
            else:
                continue

            pool = str(item.get("poolmoney", "")).strip()
            if pool.isdigit() and int(pool) > 0:
                draw["pool"] = int(pool)
            draws.append(draw)
        except (TypeError, ValueError):
            continue

    if not draws:
        raise RuntimeError(f"{game_id}: 福彩数据解析失败")
    return draws


def fetch_sporttery(game_id: str) -> list[dict]:
    game_no = GAME_META[game_id]["param"]
    draws: list[dict] = []
    seen: set[str] = set()
    for page in (1, 2):
        url = (
            "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry"
            f"?gameNo={game_no}&provinceId=0&pageSize=100&isVerify=1&pageNo={page}"
        )
        data = http_json(url, sporttery_headers())
        value = data.get("value") or {}
        items = value.get("list") or []
        if not items:
            break
        for item in items:
            try:
                issue = str(item.get("lotteryDrawNum", "")).strip()
                date = str(item.get("lotteryDrawTime", "")).strip()
                nums = [
                    int(x) for x in str(item.get("lotteryDrawResult", "")).replace(",", " ").split()
                    if x.strip() != ""
                ]
                if not issue or not date or issue in seen:
                    continue
                if game_id == "dlt":
                    if len(nums) != 7 or not all(1 <= n <= 35 for n in nums[:5]) or not all(1 <= n <= 12 for n in nums[5:]):
                        continue
                    draw = {"issue": issue, "date": date, "front": nums[:5], "back": nums[5:]}
                elif game_id == "p5":
                    if len(nums) != 5 or not all(0 <= n <= 9 for n in nums):
                        continue
                    draw = {"issue": issue, "date": date, "digits": nums}
                else:
                    continue

                if game_id == "dlt":
                    for key in ("poolBalanceAfterdraw", "poolBalance"):
                        raw = str(item.get(key, "")).replace(",", "").strip()
                        if raw:
                            try:
                                pool = float(raw)
                                if pool > 0:
                                    draw["pool"] = int(pool)
                                    break
                            except ValueError:
                                pass
                seen.add(issue)
                draws.append(draw)
            except (TypeError, ValueError):
                continue
        if len(items) < 100:
            break

    if not draws:
        raise RuntimeError(f"{game_id}: 体彩接口返回空数据")
    return draws


# ---------------- 500.com 备用数据源 ----------------
# GitHub Actions 的海外服务器通常无法访问福彩/体彩官方接口，
# 因此增加 500.com 的公开历史数据页作为兜底。

TD_RE = re.compile(r"<td([^>]*)>(.*?)</td>", re.I | re.S)
TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.I | re.S)
CLASS_RE = re.compile(r'class="([^"]*)"', re.I)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
ISSUE_RE = re.compile(r"\d{5,7}")


def parse_cells(row: str) -> list[dict]:
    cells = []
    for attrs, inner in TD_RE.findall(row):
        text = html_lib.unescape(re.sub(r"<[^>]+>", "", inner))
        text = text.replace("\xa0", " ").strip()
        cls = CLASS_RE.search(attrs)
        cells.append({"class": cls.group(1) if cls else "", "text": text})
    return cells


def normalize_issue(game_id: str, issue: str) -> str:
    issue = issue.strip()
    # 500.com 双色球期号为 5 位（26128），官方接口为 7 位（2026128）
    if game_id == "ssq" and re.fullmatch(r"\d{5}", issue):
        return "20" + issue
    return issue


def parse_date(cells: list[dict]) -> str:
    for cell in cells:
        if DATE_RE.fullmatch(cell["text"]):
            return cell["text"]
    return ""


def fill_missing_dates(draws: list[dict], existing: list[dict]) -> None:
    known = {str(d.get("issue")): d.get("date", "") for d in existing if d.get("date")}
    for draw in draws:
        if not draw.get("date") and known.get(str(draw["issue"])):
            draw["date"] = known[str(draw["issue"])]

    anchors = [d for d in list(existing) + list(draws) if d.get("date")]
    if not anchors:
        return
    anchors.sort(key=issue_key, reverse=True)
    base = anchors[0]
    try:
        base_date = datetime.fromisoformat(str(base["date"])).date()
    except ValueError:
        return
    for draw in draws:
        if draw.get("date"):
            continue
        delta = issue_key(draw) - issue_key(base)
        if -60 <= delta <= 60:
            draw["date"] = (base_date + timedelta(days=delta)).isoformat()


def fetch_500(game_id: str, existing: list[dict]) -> list[dict]:
    if game_id in ("ssq", "dlt"):
        path = "ssq" if game_id == "ssq" else "dlt"
        url = f"{FIVE_HUNDRED}/{path}/history/newinc/history.php"
    else:
        path = {"fc3d": "sd", "p5": "plw", "kl8": "kl8"}[game_id]
        page = "jbzs_redblue.shtml" if game_id == "kl8" else "jbzs.shtml"
        url = f"{FIVE_HUNDRED}/{path}/zoushi/{page}?expect=100"

    html = http_text(url, five_headers())
    draws: dict[str, dict] = {}

    for row in TR_RE.findall(html):
        cells = parse_cells(row)
        if len(cells) < 3:
            continue
        texts = [c["text"] for c in cells]

        if game_id in ("ssq", "dlt"):
            if len(texts) < 9:
                continue
            issue = normalize_issue(game_id, texts[1])
            if not ISSUE_RE.fullmatch(issue):
                continue
            main = [int(c["text"]) for c in cells if "cfont2" in c["class"] and c["text"].isdigit()]
            special = [int(c["text"]) for c in cells if "cfont4" in c["class"] and c["text"].isdigit()]
            try:
                if game_id == "ssq":
                    if len(main) != 6 or len(special) < 1:
                        continue
                    if not all(1 <= n <= 33 for n in main) or not (1 <= special[0] <= 16):
                        continue
                    draw = {"issue": issue, "date": parse_date(cells), "red": sorted(main), "blue": [special[0]]}
                    pool_idx = 10
                else:
                    if len(main) != 5 or len(special) != 2:
                        continue
                    if not all(1 <= n <= 35 for n in main) or not all(1 <= n <= 12 for n in special):
                        continue
                    draw = {"issue": issue, "date": parse_date(cells), "front": main, "back": special}
                    pool_idx = 9
                if len(texts) > pool_idx:
                    pool = texts[pool_idx].replace(",", "")
                    if pool.isdigit() and int(pool) > 0:
                        draw["pool"] = int(pool)
            except ValueError:
                continue
            draws[issue] = draw
            continue

        issue = ""
        for idx in (0, 1):
            if len(texts) > idx and ISSUE_RE.fullmatch(texts[idx]):
                issue = texts[idx]
                break
        if not issue:
            continue
        balls = [int(c["text"]) for c in cells if "chartBall" in c["class"] and c["text"].isdigit()]
        try:
            if game_id == "fc3d":
                if len(balls) < 3 or not all(0 <= n <= 9 for n in balls[:3]):
                    continue
                draw = {"issue": issue, "date": parse_date(cells), "digits": balls[:3]}
            elif game_id == "p5":
                if len(balls) < 5 or not all(0 <= n <= 9 for n in balls[:5]):
                    continue
                draw = {"issue": issue, "date": parse_date(cells), "digits": balls[:5]}
            elif game_id == "kl8":
                nums = sorted(balls[:20])
                if len(nums) != 20 or len(set(nums)) != 20 or not all(1 <= n <= 80 for n in nums):
                    continue
                draw = {"issue": issue, "date": parse_date(cells), "nums": nums}
            else:
                continue
        except ValueError:
            continue
        draws[issue] = draw

    if not draws:
        raise RuntimeError(f"{game_id}: 500.com 备用源返回空数据")

    result = sorted(draws.values(), key=issue_key, reverse=True)
    fill_missing_dates(result, existing)
    return result


def issue_key(draw: dict) -> int:
    issue = str(draw.get("issue", ""))
    digits = "".join(ch for ch in issue if ch.isdigit())
    try:
        return int(digits)
    except ValueError:
        return 0


def merge(existing: list[dict], incoming: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    for draw in existing + incoming:
        issue = str(draw.get("issue", "")).strip()
        if issue:
            merged[issue] = draw
    result = sorted(merged.values(), key=issue_key, reverse=True)
    return result[:MAX_DRAWS]


def load_existing() -> dict:
    if not DATA_FILE.exists():
        return {}
    try:
        with DATA_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001
        log(f"! 读取旧数据失败：{exc}")
        return {}


def main() -> int:
    existing = load_existing()
    old_games = existing.get("games", {}) if isinstance(existing.get("games"), dict) else {}
    games: dict[str, dict] = {}
    errors: list[str] = []
    ok_count = 0

    for game_id, meta in GAME_META.items():
        log(f"→ 抓取 {meta['name']}（{game_id}）…")
        old = (old_games.get(game_id) or {}).get("draws") or []
        incoming = None
        source_used = ""
        failures: list[str] = []

        if SOURCE_MODE in ("auto", "official"):
            try:
                if meta["source"] == "cwl":
                    incoming = fetch_cwl(game_id)
                else:
                    incoming = fetch_sporttery(game_id)
                source_used = "official"
            except Exception as exc:  # noqa: BLE001
                failures.append(f"official: {exc}")
                log(f"  ! 官方源失败：{exc}")

        if incoming is None and SOURCE_MODE in ("auto", "500"):
            try:
                incoming = fetch_500(game_id, old)
                source_used = "500"
                log("  ✓ 500.com 备用源成功")
            except Exception as exc:  # noqa: BLE001
                failures.append(f"500: {exc}")
                log(f"  ! 500.com 备用源失败：{exc}")

        if incoming is None:
            errors.append(f"{game_id}: " + " | ".join(failures))
            if old:
                keep = dict(old_games.get(game_id) or {})
                keep.setdefault("name", meta["name"])
                keep.setdefault("source", "cache")
                games[game_id] = keep
                log("  · 保留上次成功抓取的数据")
            continue

        merged = merge(old, incoming)
        games[game_id] = {"name": meta["name"], "draws": merged, "source": source_used}
        ok_count += 1
        latest = merged[0]
        log(f"  ✓ {len(incoming)} 条（{source_used}），合并后 {len(merged)} 条，最新 {latest['issue']} {latest.get('date', '')}")

    if not games:
        log("!! 所有数据源均失败，保持原文件不变")
        return 1

    now = datetime.now(CST)
    payload = {
        "version": 1,
        "updated": now.isoformat(timespec="seconds"),
        "timezone": "Asia/Shanghai",
        "sources": {
            "cwl": "https://www.cwl.gov.cn/",
            "sporttery": "https://www.sporttery.cn/",
            "500": "https://datachart.500.com/",
        },
        "errors": errors,
        "games": games,
    }

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1, sort_keys=False)
        fh.write("\n")
    tmp.replace(DATA_FILE)

    total = sum(len(g["draws"]) for g in games.values())
    log(f"✓ 写入 {DATA_FILE}（{total} 条记录，{ok_count}/5 个数据源成功）")
    if errors:
        log("  部分失败：" + "；".join(errors))
    return 0


if __name__ == "__main__":
    sys.exit(main())
