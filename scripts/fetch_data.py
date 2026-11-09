#!/usr/bin/env python3
"""抓取五种数字彩的官方开奖数据，合并写入 data/lottery.json。

数据源（均为官方公开接口）：
  福彩：双色球 ssq / 福彩3D 3d / 快乐8 kl8  ->  www.cwl.gov.cn
  体彩：大乐透 dlt / 排列5 p5               ->  webapi.sporttery.cn

脚本只使用 Python 标准库，可在 GitHub Actions 中直接运行。
"""
from __future__ import annotations

import json
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
        try:
            if meta["source"] == "cwl":
                incoming = fetch_cwl(game_id)
            else:
                incoming = fetch_sporttery(game_id)
            old = (old_games.get(game_id) or {}).get("draws") or []
            merged = merge(old, incoming)
            games[game_id] = {"name": meta["name"], "draws": merged}
            ok_count += 1
            log(f"  ✓ {len(incoming)} 条，合并后 {len(merged)} 条，最新 {merged[0]['issue']} {merged[0]['date']}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{game_id}: {exc}")
            log(f"  × {exc}")
            if game_id in old_games:
                games[game_id] = old_games[game_id]
                log("  · 保留上次成功抓取的数据")

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
