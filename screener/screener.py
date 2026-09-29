"""
台股 SEPA / VCP 每日篩選（第 1 步：技術面客觀評分）

流程：
1. 取得上市櫃普通股清單（FinMind，失敗改用證交所/櫃買 OpenAPI）
2. 用 yfinance 下載約 2 年日 K（還原權息）
3. 先過「趨勢模板」8 條（超級績效），過關才進入評分
4. 對過關股票計算 4 條型態規則＋突破訊號，並算出建議買點、停損、風險
5. 產業族群強度：各產業平均 RS、趨勢模板過關比例，找出主流族群
6. 基本面（fundamentals.py）：書中基本面分、循環分、擴產標籤
7. 輸出 docs/data/latest.json 與 docs/data/history/<日期>.json 給網站用
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "data"
HIST_DIR = OUT_DIR / "history"

# ===== 規則參數（要調整門檻改這裡）=====
P = {
    "min_rows": 220,              # 至少要有的交易日數（算 MA200 用）
    "min_turnover": 10_000_000,   # 近 20 日平均成交金額下限（元），太冷門的不看
    "rs_min": 70,                 # 趨勢模板：RS 評分下限（1~99）
    "low_mult": 1.30,             # 趨勢模板：離一年低點至少 +30%
    "high_ratio": 0.75,           # 趨勢模板：在一年高點的 75% 以上
    # 規則 1 不追高
    "ext_ma50_max": 0.25,         # 離 50 日線不超過 25%
    "ret20_max": 0.40,            # 20 日漲幅不超過 40%
    # 規則 2 接近突破點
    "near_high": 0.05,            # 在一年高點下方 5% 以內
    "above_pivot_max": 0.05,      # 已突破樞紐點不超過 5%
    # 規則 3 波動收斂
    "last_range_max": 0.10,       # 最近 10 日高低區間 < 10%
    # 規則 4 量縮
    "dry_ratio": 0.70,            # 近 10 日均量 < 50 日均量的 70%
    # 突破確認
    "bo_vol_ratio": 1.5,          # 當日量 > 50 日均量 1.5 倍
    # 部位
    "risk_max": 0.08,             # 停損距離超過 8% 就不做
    "new_lookback": 20,           # 近 N 個交易日沒上榜過 = 新
    # 產業族群強度（自行量化）
    "ind_min_n": 5,               # 產業至少幾檔可計算股票才排名
    "ind_hot_top": 5,             # 平均 RS 前幾名的產業算「主流族群」
    "ind_hot_pass": 3,            # 而且至少要有幾檔過趨勢模板
}

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
UA = {"User-Agent": "Mozilla/5.0 (stock-screener; personal use)"}
EXCLUDE_IND = ("ETF", "ETN", "指數", "受益證券", "存託憑證", "大盤", "Index", "權證")


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 股票清單
def universe_finmind() -> pd.DataFrame:
    headers = dict(UA)
    tok = os.getenv("FINMIND_TOKEN", "").strip()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    r = requests.get(FINMIND_URL, params={"dataset": "TaiwanStockInfo"}, headers=headers, timeout=60)
    r.raise_for_status()
    df = pd.DataFrame(r.json().get("data", []))
    if df.empty:
        raise RuntimeError("FinMind 回傳空清單")
    df = df[df["type"].isin(["twse", "tpex"])]
    df = df[df["stock_id"].str.fullmatch(r"[1-9]\d{3}")]
    df = df[~df["industry_category"].fillna("").str.contains("|".join(EXCLUDE_IND))]
    df = df.drop_duplicates("stock_id", keep="first")
    return pd.DataFrame({
        "id": df["stock_id"], "name": df["stock_name"],
        "industry": df["industry_category"].fillna(""), "market": df["type"],
    })


def universe_openapi() -> pd.DataFrame:
    rows = []
    r = requests.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", headers=UA, timeout=60)
    r.raise_for_status()
    for x in r.json():
        rows.append((x.get("Code", ""), x.get("Name", ""), "", "twse"))
    r = requests.get("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes", headers=UA, timeout=60)
    r.raise_for_status()
    for x in r.json():
        rows.append((x.get("SecuritiesCompanyCode", ""), x.get("CompanyName", ""), "", "tpex"))
    df = pd.DataFrame(rows, columns=["id", "name", "industry", "market"])
    df = df[df["id"].str.fullmatch(r"[1-9]\d{3}")].drop_duplicates("id")
    return df


def get_universe() -> pd.DataFrame:
    try:
        df = universe_finmind()
        log(f"股票清單（FinMind）：{len(df)} 檔")
        return df
    except Exception as e:  # noqa: BLE001
        log(f"FinMind 失敗（{e}），改用證交所/櫃買 OpenAPI")
    df = universe_openapi()
    log(f"股票清單（OpenAPI）：{len(df)} 檔")
    return df


# ---------------------------------------------------------------- 股價
def _extract(data: pd.DataFrame, ticker: str) -> pd.DataFrame | None:
    if data is None or data.empty:
        return None
    if isinstance(data.columns, pd.MultiIndex):
        lv0 = data.columns.get_level_values(0)
        lv1 = data.columns.get_level_values(1)
        if ticker in lv0:
            sub = data[ticker]
        elif ticker in lv1:
            sub = data.xs(ticker, axis=1, level=1)
        else:
            return None
    else:
        sub = data
    need = ["Open", "High", "Low", "Close", "Volume"]
    if not all(c in sub.columns for c in need):
        return None
    sub = sub[need].dropna(subset=["Close"])
    sub = sub[sub["Volume"] > 0]
    return sub if len(sub) else None


def download_prices(tickers: list[str], chunk: int = 100, period: str = "2y",
                    start: str | None = None) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    out: dict[str, pd.DataFrame] = {}

    def fetch(batch):
        for attempt in range(3):
            try:
                span = {"start": start} if start else {"period": period}
                return yf.download(batch, interval="1d", group_by="ticker",
                                   auto_adjust=True, progress=False, threads=True, **span)
            except Exception as e:  # noqa: BLE001
                log(f"  下載失敗（第 {attempt + 1} 次）：{e}")
                time.sleep(20 * (attempt + 1))
        return None

    for i in range(0, len(tickers), chunk):
        batch = tickers[i:i + chunk]
        data = fetch(batch)
        for t in batch:
            df = _extract(data, t)
            if df is not None:
                out[t] = df
        log(f"  已下載 {min(i + chunk, len(tickers))}/{len(tickers)}，成功 {len(out)}")
        time.sleep(2)

    missing = [t for t in tickers if t not in out]
    if missing:
        log(f"補抓缺漏 {len(missing)} 檔")
        time.sleep(30)
        for i in range(0, len(missing), 40):
            batch = missing[i:i + 40]
            data = fetch(batch)
            for t in batch:
                df = _extract(data, t)
                if df is not None:
                    out[t] = df
            time.sleep(3)
    return out


def download_index(period: str = "2y", start: str | None = None) -> pd.DataFrame:
    import yfinance as yf
    span = {"start": start} if start else {"period": period}
    for attempt in range(3):
        try:
            df = yf.Ticker("^TWII").history(auto_adjust=True, **span)
            if len(df):
                return df
        except Exception as e:  # noqa: BLE001
            log(f"大盤下載失敗：{e}")
        time.sleep(15)
    raise RuntimeError("無法取得加權指數")


# ---------------------------------------------------------------- 計算
def _f(x, nd=2):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def _ret(c: np.ndarray, k: int) -> float:
    if len(c) <= k:
        return float("nan")
    return c[-1] / c[-1 - k] - 1


def _range(h: np.ndarray, l: np.ndarray) -> float:
    lo = l.min()
    return (h.max() - lo) / lo if lo > 0 else float("nan")


def analyze(df: pd.DataFrame) -> dict | None:
    n = len(df)
    if n < P["min_rows"]:
        return None
    c = df["Close"].to_numpy(float)
    h = df["High"].to_numpy(float)
    l = df["Low"].to_numpy(float)
    v = df["Volume"].to_numpy(float)

    turnover20 = float(np.mean(c[-20:] * v[-20:]))
    if turnover20 < P["min_turnover"]:
        return None

    cs = pd.Series(c)
    ma50 = cs.rolling(50).mean().to_numpy()
    ma150 = cs.rolling(150).mean().to_numpy()
    ma200 = cs.rolling(200).mean().to_numpy()
    close = c[-1]
    hi252 = h[-252:].max()
    lo252 = l[-252:].min()

    ret20 = _ret(c, 20)
    rs_raw = 0.4 * _ret(c, 63) + 0.2 * _ret(c, 126) + 0.2 * _ret(c, 189) + 0.2 * _ret(c, min(251, n - 1))

    # 型態用「今天以前」的 10 / 20 / 40 日窗口，讓突破當天不會被自己的大量或長紅干擾
    ph, pl, pv = h[:-1], l[:-1], v[:-1]
    r1 = _range(ph[-10:], pl[-10:])
    r2 = _range(ph[-30:-10], pl[-30:-10])
    r3 = _range(ph[-70:-30], pl[-70:-30])
    vol50 = float(np.mean(pv[-50:]))
    vol10 = float(np.mean(pv[-10:]))
    pivot = float(ph[-10:].max())       # 樞紐點 = 最近 10 日（不含今天）最高價
    stop = float(pl[-10:].min())        # 停損 = 最近 10 日（不含今天）最低價

    return {
        "close": close, "ma50": ma50[-1], "ma150": ma150[-1], "ma200": ma200[-1],
        "ma200_prev": ma200[-22], "hi252": hi252, "lo252": lo252,
        "ret20": ret20, "rs_raw": rs_raw, "turnover20": turnover20,
        "r1": r1, "r2": r2, "r3": r3, "vol50": vol50, "vol10": vol10,
        "vol_today": v[-1], "high_today": h[-1], "low_today": l[-1],
        "pivot": pivot, "stop": stop, "date": df.index[-1].date().isoformat(),
    }


def rs_rating(raw: pd.Series) -> pd.Series:
    """把加權報酬轉成 1~99 的百分位（類似 IBD 的 RS Rating）"""
    pct = raw.rank(pct=True)
    return (pct * 98 + 1).round().clip(1, 99)


def score(a: dict, mkt_ret20: float) -> dict:
    c = a["close"]
    trend = {
        "t1": c > a["ma150"] and c > a["ma200"],
        "t2": a["ma150"] > a["ma200"],
        "t3": a["ma200"] > a["ma200_prev"],
        "t4": a["ma50"] > a["ma150"] and a["ma50"] > a["ma200"],
        "t5": c > a["ma50"],
        "t6": c >= a["lo252"] * P["low_mult"],
        "t7": c >= a["hi252"] * P["high_ratio"],
        "t8": a["rs"] >= P["rs_min"],
    }
    ext50 = c / a["ma50"] - 1
    dist_hi = c / a["hi252"] - 1
    rules = {
        "r1": ext50 <= P["ext_ma50_max"] and a["ret20"] <= P["ret20_max"],
        "r2": dist_hi >= -P["near_high"] and c <= a["pivot"] * (1 + P["above_pivot_max"]),
        "r3": (a["r1"] < a["r2"] < a["r3"]) and a["r1"] <= P["last_range_max"],
        "r4": a["vol10"] < a["vol50"] * P["dry_ratio"],
    }
    day_rng = a["high_today"] - a["low_today"]
    close_pos = (c - a["low_today"]) / day_rng if day_rng > 0 else 1.0
    vol_ratio = a["vol_today"] / a["vol50"] if a["vol50"] > 0 else float("nan")
    breakout = bool(c > a["pivot"] and vol_ratio >= P["bo_vol_ratio"] and close_pos >= 0.5)

    entry = max(a["pivot"], c)
    stop = a["stop"]
    risk = (entry - stop) / entry if entry > stop > 0 else float("nan")
    return {
        "trend": trend, "trend_ok": all(trend.values()),
        "rules": rules, "score": int(sum(rules.values())), "breakout": breakout,
        "ext50": ext50, "dist_hi": dist_hi, "vol_ratio": vol_ratio, "close_pos": close_pos,
        "entry": entry, "stop": stop, "risk": risk,
        "risk_ok": bool(not math.isnan(risk) and risk <= P["risk_max"]),
        "beat_mkt": bool(a["ret20"] > mkt_ret20),
    }


# ---------------------------------------------------------------- 主程式
def recent_ids(today: str) -> set[str]:
    if not HIST_DIR.exists():
        return set()
    files = sorted(p for p in HIST_DIR.glob("*.json") if p.stem < today)[-P["new_lookback"]:]
    ids: set[str] = set()
    for p in files:
        try:
            ids.update(json.loads(p.read_text(encoding="utf-8")).get("ids", []))
        except Exception:  # noqa: BLE001
            pass
    return ids


def market_info(idx: pd.DataFrame) -> dict:
    c = idx["Close"].astype(float)
    ma50, ma200 = c.rolling(50).mean().iloc[-1], c.rolling(200).mean().iloc[-1]
    last = c.iloc[-1]
    return {
        "date": idx.index[-1].date().isoformat(), "close": _f(last),
        "ma50": _f(ma50), "ma200": _f(ma200),
        "above50": bool(last > ma50), "above200": bool(last > ma200),
        "ma50_up": bool(ma50 > c.rolling(50).mean().iloc[-6]),
        "ret20": _f(_ret(c.to_numpy(), 20) * 100),
    }


def run(universe: pd.DataFrame, prices: dict[str, pd.DataFrame], idx: pd.DataFrame) -> dict:
    mkt = market_info(idx)
    mkt_date = mkt["date"]
    mkt_ret20 = (mkt["ret20"] or 0) / 100

    rows = []
    dfs: dict[str, pd.DataFrame] = {}
    for _, u in universe.iterrows():
        t = u["id"] + (".TW" if u["market"] == "twse" else ".TWO")
        df = prices.get(t)
        if df is None:
            continue
        a = analyze(df)
        if a is None or a["date"] != mkt_date:   # 停牌或資料未更新的跳過
            continue
        a.update(id=u["id"], name=u["name"], industry=u["industry"], market=u["market"])
        rows.append(a)
        dfs[u["id"]] = df
    log(f"可計算股票：{len(rows)} 檔")
    if not rows:
        raise RuntimeError("沒有任何股票可計算，可能是資料來源失敗")

    rs = rs_rating(pd.Series([r["rs_raw"] for r in rows]).fillna(-9))
    for r, v in zip(rows, rs):
        r["rs"] = int(v)

    prev = recent_ids(mkt_date)
    picked = []
    for a in rows:
        s = score(a, mkt_ret20)
        if not s["trend_ok"]:
            continue
        picked.append({
            "id": a["id"], "name": a["name"], "industry": a["industry"],
            "ex": "TPEX" if a["market"] == "tpex" else "TWSE",
            "close": _f(a["close"]), "rs": a["rs"],
            "ret20": _f(a["ret20"] * 100), "ext50": _f(s["ext50"] * 100),
            "dist_hi": _f(s["dist_hi"] * 100),
            "r1": _f(a["r1"] * 100, 1), "r2": _f(a["r2"] * 100, 1), "r3": _f(a["r3"] * 100, 1),
            "dry": _f(a["vol10"] / a["vol50"] if a["vol50"] else None),
            "vol_ratio": _f(s["vol_ratio"]),
            "turnover": _f(a["turnover20"] / 1e8, 2),   # 億元
            "rules": {k: bool(v) for k, v in s["rules"].items()},
            "score": s["score"], "breakout": s["breakout"],
            "entry": _f(s["entry"]), "stop": _f(s["stop"]), "pivot": _f(a["pivot"]),
            "risk": _f(s["risk"] * 100), "risk_ok": s["risk_ok"],
            "beat_mkt": s["beat_mkt"], "new": a["id"] not in prev,
        })

    ind_count: dict[str, int] = {}
    for p in picked:
        ind_count[p["industry"]] = ind_count.get(p["industry"], 0) + 1
    for p in picked:
        p["ind_n"] = ind_count.get(p["industry"], 0) if p["industry"] else 0

    industries = industry_strength(rows, ind_count)
    ind_map = {x["industry"]: x for x in industries}
    for p in picked:
        x = ind_map.get(p["industry"])
        p["ind_rank"] = x["rank"] if x else None
        p["ind_rs"] = x["avg_rs"] if x else None
        p["ind_hot"] = bool(x and x["hot"])

    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import fundamentals
        fund_stat = fundamentals.attach(picked, OUT_DIR, dt.date.fromisoformat(mkt_date))
    except Exception as e:  # noqa: BLE001  基本面失敗不影響技術面篩選
        log(f"⚠️ 基本面更新失敗：{e}")
        fund_stat = {"error": str(e)}

    def fund_total(p):
        f = p.get("fund") or {}
        return f.get("fscore", 0) + f.get("cscore", 0)

    picked.sort(key=lambda p: (p["score"], p["breakout"], p["risk_ok"], fund_total(p), p["rs"]), reverse=True)
    log(f"趨勢模板過關：{len(picked)} 檔；滿分 {sum(p['score'] == 4 for p in picked)} 檔；"
        f"今日突破 {sum(p['breakout'] for p in picked)} 檔")

    return {
        "date": mkt_date,
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="minutes"),
        "universe": len(rows), "market": mkt, "params": P, "stocks": picked,
        "industries": industries, "fund_stat": fund_stat,
        "_charts": {p["id"]: chart_data(dfs[p["id"]]) for p in picked},
    }


def industry_strength(rows: list[dict], pass_count: dict[str, int]) -> list[dict]:
    """產業族群強度：產業內所有可計算股票的平均 RS、過趨勢模板的檔數與比例"""
    by: dict[str, list[int]] = {}
    for r in rows:
        if r.get("industry"):
            by.setdefault(r["industry"], []).append(r["rs"])
    out = []
    for ind, rs in by.items():
        if len(rs) < P["ind_min_n"]:
            continue
        n_pass = pass_count.get(ind, 0)
        out.append({"industry": ind, "n": len(rs), "n_pass": n_pass,
                    "pass_pct": _f(n_pass / len(rs) * 100, 1), "avg_rs": _f(sum(rs) / len(rs), 1)})
    out.sort(key=lambda x: x["avg_rs"], reverse=True)
    for i, x in enumerate(out, 1):
        x["rank"] = i
        x["hot"] = bool(i <= P["ind_hot_top"] and x["n_pass"] >= P["ind_hot_pass"])
    return out


def chart_data(df: pd.DataFrame, n: int = 260) -> dict:
    """網站畫 K 線用：最近約一年的日 K 與 50/150/200 日線"""
    c = df["Close"].astype(float)
    mas = {k: c.rolling(k).mean() for k in (50, 150, 200)}
    d = df.iloc[-n:]
    r = lambda s: [None if pd.isna(x) else round(float(x), 2) for x in s]  # noqa: E731
    return {
        "t": [x.date().isoformat() for x in d.index],
        "o": r(d["Open"]), "h": r(d["High"]), "l": r(d["Low"]), "c": r(d["Close"]),
        "v": [int(x) for x in d["Volume"]],
        "ma50": r(mas[50].iloc[-n:]), "ma150": r(mas[150].iloc[-n:]), "ma200": r(mas[200].iloc[-n:]),
    }


def save(result: dict) -> None:
    charts = result.pop("_charts", {})
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cdir = OUT_DIR / "ohlc"
    cdir.mkdir(exist_ok=True)
    for f in cdir.glob("*.json"):
        f.unlink()
    for sid, cd in charts.items():
        (cdir / f"{sid}.json").write_text(json.dumps(cd, separators=(",", ":")), encoding="utf-8")
    HIST_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    (OUT_DIR / "latest.json").write_text(payload, encoding="utf-8")
    daily = OUT_DIR / "daily"
    daily.mkdir(exist_ok=True)
    (daily / f"{result['date']}.json").write_text(payload, encoding="utf-8")
    hist = {"date": result["date"], "ids": [s["id"] for s in result["stocks"]]}
    (HIST_DIR / f"{result['date']}.json").write_text(json.dumps(hist, ensure_ascii=False), encoding="utf-8")
    dates = sorted(p.stem for p in HIST_DIR.glob("*.json"))
    (OUT_DIR / "dates.json").write_text(json.dumps(dates[::-1]), encoding="utf-8")
    log(f"已輸出 {OUT_DIR / 'latest.json'}")


def main() -> int:
    universe = get_universe()
    idx = download_index()
    tickers = [i + (".TW" if m == "twse" else ".TWO") for i, m in zip(universe["id"], universe["market"])]
    prices = download_prices(tickers)
    log(f"股價下載完成：{len(prices)}/{len(tickers)}")
    if len(prices) < len(tickers) * 0.5:
        log("⚠️ 下載成功率低於 5 成，為避免錯誤結果，這次不更新")
        return 1
    result = run(universe, prices, idx)
    save(result)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import tracking
        tracking.update(result, prices, idx, OUT_DIR, P["risk_max"])
    except Exception as e:  # noqa: BLE001  追蹤失敗不影響每日篩選
        log(f"⚠️ 追蹤更新失敗：{e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
