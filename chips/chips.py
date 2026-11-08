#!/usr/bin/env python3
"""
Atlas 每日籌碼資料（給手機 App 讀）
------------------------------------------------------------
資料來源（官方、免費、不用金鑰）：
  上市：證交所 T86（三大法人）、MI_MARGN（融資融券）、MI_INDEX（收盤行情）、BFI82U（法人金額）
  上櫃：櫃買中心 insti/dailyTrade、margin/balance、afterTrading/dailyQuotes
輸出（寫到 chips-data 分支，只保留最新一份，不會讓 repo 越長越大）：
  db/YYYYMMDD.json   每天一份全市場原始數字（保留最近 KEEP 個交易日）
  s/<代號>.json      每檔最近 HIST 個交易日：外資、投信、自營、融資、融券、收盤、成交量
  rank.json          全市場排行用的指標（連買天數、5/20 日累積、站上月線、量比…）
  market.json        大盤：漲跌家數、三大法人買賣金額
單位：法人／成交量＝張（1000 股），融資券＝張，金額＝億元
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

import requests

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "chips-out")
DB, SD = OUT / "db", OUT / "s"
KEEP, HIST = 150, 130          # 保留交易日數 / 個股檔案天數
MAX_BACK_DAYS = 230            # 第一次回補最多往回找幾個日曆天
REFRESH_RECENT = 3             # 最近幾個交易日如果資料不完整就重抓
TW = dt.timezone(dt.timedelta(hours=8))
CODE_RE = re.compile(r"^([1-9]\d{3}|00\d{2,4}[A-Z]?)$")
STOCK_RE = re.compile(r"^[1-9]\d{3}$")
S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Atlas personal chips)", "Accept": "application/json"})
_last = [0.0]


def log(*a):
    print(*a, flush=True)


def get(url: str):
    """每次請求間隔 ≥ 3.2 秒（證交所限制每 5 秒 3 次），失敗重試 3 次"""
    for i in range(3):
        w = 3.2 - (time.time() - _last[0])
        if w > 0:
            time.sleep(w)
        try:
            r = S.get(url, timeout=45)
            _last[0] = time.time()
            if r.status_code == 200:
                return r.json()
            log(f"  HTTP {r.status_code} {url[:90]}")
        except Exception as e:  # noqa: BLE001
            _last[0] = time.time()
            log(f"  失敗 {e.__class__.__name__} {url[:90]}")
        time.sleep(8 * (i + 1))
    return None


def num(s):
    s = re.sub(r"<[^>]+>", "", str(s)).replace(",", "").strip()
    if s in ("", "--", "---", "X", "除權息", "除息", "除權"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def lots(s):
    v = num(s)
    return None if v is None else round(v / 1000)


def i0(v):
    return None if v is None else int(round(v))


def tables(j):
    if not j:
        return []
    if "tables" in j:
        return [t for t in j["tables"] if t and t.get("data") is not None]
    if "data" in j and "fields" in j:
        return [{"title": j.get("title", ""), "fields": j["fields"], "data": j["data"]}]
    return []


# ---------------------------------------------------------------- 上市
def twse_day(d: dt.date):
    ds = d.strftime("%Y%m%d")
    j = get(f"https://www.twse.com.tw/rwd/zh/fund/T86?date={ds}&selectType=ALLBUT0999&response=json")
    if not j:
        return None, {}
    if j.get("stat") != "OK" or not j.get("data"):
        return "holiday", {}
    out, names = {}, {}
    f = j["fields"]
    ix = lambda key, dflt: next((k for k, x in enumerate(f) if key(x)), dflt)  # noqa: E731
    fi = ix(lambda x: "外陸資買賣超" in x and "不含" in x, 4)
    ti = ix(lambda x: x.startswith("投信買賣超"), 10)
    di = ix(lambda x: x == "自營商買賣超股數", 11)
    for r in j["data"]:
        c = r[0].strip()
        if not CODE_RE.match(c):
            continue
        names[c] = r[1].strip()
        out[c] = {"f": lots(r[fi]), "t": lots(r[ti]), "dl": lots(r[di])}
    # 融資融券
    m = get(f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date={ds}&selectType=ALL&response=json")
    for t in tables(m):
        if t["fields"] and t["fields"][0] == "代號" and len(t["fields"]) >= 13:
            for r in t["data"]:
                c = r[0].strip()
                if c in out or CODE_RE.match(c):
                    o = out.setdefault(c, {})
                    o["mb"], o["sb"] = i0(num(r[6])), i0(num(r[12]))
    # 收盤行情
    q = get(f"https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date={ds}&type=ALLBUT0999&response=json")
    for t in tables(q):
        if "每日收盤行情" in t.get("title", "") and t["fields"][0] == "證券代號":
            for r in t["data"]:
                c = r[0].strip()
                if not CODE_RE.match(c):
                    continue
                close, diff = num(r[8]), num(r[10])
                sign = -1 if "-" in re.sub(r"<[^>]+>", "", str(r[9])) else 1
                o = out.setdefault(c, {})
                names.setdefault(c, r[1].strip())
                o["c"] = close
                o["chg"] = None if diff is None else round(sign * diff, 2)
                o["v"] = lots(r[2])
    return "ok", {"r": out, "n": names}


def twse_money(d: dt.date):
    j = get(f"https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate={d.strftime('%Y%m%d')}&response=json")
    if not j or j.get("stat") != "OK":
        return None
    o = {}
    for r in j.get("data", []):
        name, net = r[0], num(r[3])
        if net is None:
            continue
        net = round(net / 1e8, 1)
        if name.startswith("外資及陸資") and ("不含" in name or "自營" not in name):
            o["f"] = net
        elif name == "投信":
            o["t"] = net
        elif name.startswith("自營商"):
            o["dl"] = round(o.get("dl", 0) + net, 1)
        elif name.startswith("合計"):
            o["all"] = net
    return o


# ---------------------------------------------------------------- 上櫃
def tpex_day(d: dt.date):
    ds = d.strftime("%Y/%m/%d")
    key = d.strftime("%Y%m%d")
    out, names = {}, {}
    j = get(f"https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={ds}&response=json")
    if not j:
        return None, {}
    if str(j.get("date", key)) != key:
        return "holiday", {}
    for t in tables(j):
        if len(t["fields"]) >= 23:
            for r in t["data"]:
                c = r[0].strip()
                if not CODE_RE.match(c):
                    continue
                names[c] = r[1].strip()
                out[c] = {"f": lots(r[4]), "t": lots(r[13]), "dl": lots(r[22])}
    m = get(f"https://www.tpex.org.tw/www/zh-tw/margin/balance?date={ds}&response=json")
    if m and str(m.get("date", key)) == key:
        for t in tables(m):
            if len(t["fields"]) >= 15:
                for r in t["data"]:
                    c = r[0].strip()
                    if CODE_RE.match(c):
                        o = out.setdefault(c, {})
                        o["mb"], o["sb"] = i0(num(r[6])), i0(num(r[14]))
    q = get(f"https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date={ds}&response=json")
    if q and str(q.get("date", key)) == key:
        for t in tables(q):
            if t["fields"] and t["fields"][0] == "代號" and len(t["fields"]) >= 9:
                for r in t["data"]:
                    c = r[0].strip()
                    if not CODE_RE.match(c):
                        continue
                    o = out.setdefault(c, {})
                    names.setdefault(c, r[1].strip())
                    o["c"], o["chg"], o["v"] = num(r[2]), num(r[3]), lots(r[8])
    return ("ok" if out else "holiday"), {"r": out, "n": names}


# ---------------------------------------------------------------- 主流程
FIELDS = ["f", "t", "dl", "mb", "sb", "c", "chg", "v"]


def complete(day: dict) -> bool:
    ok = day.get("ok", {})
    return all(ok.get(k) for k in ("twse", "tpex", "twse_m", "tpex_m", "twse_q", "tpex_q"))


def fetch_day(d: dt.date):
    log(f"抓 {d}")
    st1, a = twse_day(d)
    if st1 == "holiday":
        log("  休市")
        return "holiday"
    if st1 is None:
        return None
    st2, b = tpex_day(d)
    rows = {}
    for src, mk in ((a, "TWSE"), (b, "TPEX")):
        for c, o in (src.get("r") or {}).items():
            rows[c] = [o.get(k) for k in FIELDS] + [mk]
    names = dict(a.get("n") or {})
    names.update(b.get("n") or {})
    has = lambda src, k: any(o.get(k) is not None for o in (src.get("r") or {}).values())  # noqa: E731
    ok = {"twse": bool(a.get("r")), "tpex": st2 == "ok", "twse_m": has(a, "mb"), "tpex_m": has(b, "mb"),
          "twse_q": has(a, "c"), "tpex_q": has(b, "c")}
    day = {"d": d.isoformat(), "r": rows, "n": names, "ok": ok}
    try:
        day["money"] = twse_money(d)
    except Exception as e:  # noqa: BLE001
        log("  法人金額失敗", e)
    log(f"  {len(rows)} 檔 {ok}")
    return day


def load_db():
    DB.mkdir(parents=True, exist_ok=True)
    days = {}
    for p in sorted(DB.glob("*.json")):
        try:
            days[p.stem] = json.loads(p.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return days


def save_day(day):
    key = day["d"].replace("-", "")
    (DB / f"{key}.json").write_text(json.dumps(day, ensure_ascii=False, separators=(",", ":")), "utf-8")


def update(days: dict):
    hp = OUT / "holidays.json"
    hol = set(json.loads(hp.read_text("utf-8"))) if hp.exists() else set()
    now = dt.datetime.now(TW)
    today = now.date() if now.hour >= 15 else now.date() - dt.timedelta(days=1)   # 下午 3 點前今天的法人還沒出來
    backfill = len(days) < HIST
    span = MAX_BACK_DAYS if backfill else 12
    deadline = time.time() + 100 * 60      # 最多跑 100 分鐘（Actions 上限 150）
    seen = 0
    for i in range(span + 1):
        d = today - dt.timedelta(days=i)
        key = d.strftime("%Y%m%d")
        if d.weekday() >= 5 or key in hol:
            continue
        if time.time() > deadline:
            log("時間到，剩下的下次再補")
            break
        old = days.get(key)
        if old is None or (seen < REFRESH_RECENT and not complete(old)):
            day = fetch_day(d)
            if day == "holiday":
                if i > 0:              # 今天查不到可能只是還沒公布，不記成休市
                    hol.add(key)
                continue
            if day and (old is None or len(day["r"]) >= len(old.get("r", {})) * 0.9):
                days[key] = day
                save_day(day)
        if key in days:
            seen += 1
        if backfill and len(days) >= KEEP:
            break
    hp.write_text(json.dumps(sorted(hol)[-400:]), "utf-8")
    for k in sorted(days)[:-KEEP]:
        (DB / f"{k}.json").unlink(missing_ok=True)
        days.pop(k)


def streak(arr):
    """最近連續買超（正）或賣超（負）的天數"""
    n = 0
    for v in reversed(arr):
        if v is None:
            break
        if v > 0 and n >= 0:
            n += 1
        elif v < 0 and n <= 0:
            n -= 1
        else:
            break
    return n


def ssum(arr, k):
    xs = [v for v in arr[-k:] if v is not None]
    return sum(xs) if xs else None


def build(days: dict):
    keys = sorted(days)[-HIST:]
    if not keys:
        return
    latest = days[keys[-1]]
    names = {}
    for k in keys:
        names.update(days[k].get("n", {}))
    codes = set()
    for k in keys:
        codes.update(days[k]["r"].keys())
    SD.mkdir(parents=True, exist_ok=True)
    for p in SD.glob("*.json"):
        p.unlink()
    dates = [days[k]["d"] for k in keys]
    rank = []
    for c in sorted(codes):
        ser = {f: [] for f in FIELDS}
        mkt = None
        for k in keys:
            r = days[k]["r"].get(c)
            for i, f in enumerate(FIELDS):
                ser[f].append(r[i] if r else None)
            if r:
                mkt = r[-1]
        # 個股檔：去掉最前面全空的日子
        first = next((i for i in range(len(keys)) if ser["c"][i] is not None or ser["f"][i] is not None), len(keys))
        obj = {"n": names.get(c, ""), "m": mkt, "d": dates[first:]}
        obj.update({f: ser[f][first:] for f in FIELDS})
        (SD / f"{c}.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), "utf-8")
        # 排行（只有普通股、最新一天有成交）
        if not STOCK_RE.match(c) or c not in latest["r"]:
            continue
        cl = ser["c"]
        if cl[-1] is None:
            continue
        vv = ser["v"]
        closes = [x for x in cl if x is not None]
        ma20 = round(sum(closes[-20:]) / len(closes[-20:]), 2) if len(closes) >= 20 else None
        v20 = [x for x in vv[-21:-1] if x]
        volr = round(vv[-1] / (sum(v20) / len(v20)), 2) if v20 and vv[-1] else None
        prev = cl[-1] - (ser["chg"][-1] or 0)
        chgp = round((ser["chg"][-1] or 0) / prev * 100, 2) if prev else None

        def ret(k):
            if len(closes) > k and closes[-1 - k]:
                return round((closes[-1] / closes[-1 - k] - 1) * 100, 1)
            return None
        inst20 = sum(x or 0 for x in ser["f"][-20:]) + sum(x or 0 for x in ser["t"][-20:]) + sum(x or 0 for x in ser["dl"][-20:])
        vol20 = sum(x or 0 for x in vv[-20:])
        mb = ser["mb"]
        mb5 = (mb[-1] - mb[-6]) if len(mb) >= 6 and mb[-1] is not None and mb[-6] is not None else None
        rank.append([c, names.get(c, ""), mkt, cl[-1], chgp, vv[-1],
                     ser["f"][-1], ser["t"][-1], ser["dl"][-1],
                     ssum(ser["f"], 5), ssum(ser["t"], 5), ssum(ser["f"], 20), ssum(ser["t"], 20),
                     streak(ser["f"]), streak(ser["t"]),
                     ma20, volr, ret(5), ret(20), mb5, mb[-1],
                     round(inst20 / vol20 * 100, 1) if vol20 else None])
    cols = ["code", "name", "mkt", "close", "chgPct", "vol", "f1", "t1", "dl1", "f5", "t5", "f20", "t20",
            "fStreak", "tStreak", "ma20", "volRatio", "ret5", "ret20", "mbChg5", "mb", "inst20Pct"]
    (OUT / "rank.json").write_text(json.dumps({"d": latest["d"], "cols": cols, "rows": rank}, ensure_ascii=False, separators=(",", ":")), "utf-8")
    # 大盤
    up = sum(1 for r in rank if (r[4] or 0) > 0)
    down = sum(1 for r in rank if (r[4] or 0) < 0)
    mkt = {"d": latest["d"], "up": up, "down": down, "flat": len(rank) - up - down,
           "money": latest.get("money"),
           "hist": [{"d": days[k]["d"], "money": days[k].get("money")} for k in keys[-20:]]}
    (OUT / "market.json").write_text(json.dumps(mkt, ensure_ascii=False, separators=(",", ":")), "utf-8")
    log(f"完成：{len(codes)} 檔個股檔、排行 {len(rank)} 檔、最新 {latest['d']}、共 {len(keys)} 天")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    days = load_db()
    log(f"已有 {len(days)} 天資料")
    update(days)
    build(days)
    (OUT / "README.md").write_text("Atlas 每日籌碼資料（自動產生，請勿手動修改）\n", "utf-8")


if __name__ == "__main__":
    main()
