"""
基本面資料與評分（第 2 步）

只替「趨勢模板過關」的股票抓基本面，資料來自 FinMind（需要 FINMIND_TOKEN，免費會員每小時約 600 次）：
- 月營收 TaiwanStockMonthRevenue
- 綜合損益表 TaiwanStockFinancialStatements（EPS、營收、毛利、營業利益）
- 現金流量表 TaiwanStockCashFlowsStatement（取得不動產廠房設備＝資本支出、折舊）

快取在 docs/data/fund/<代號>.json，只在「應該有新資料」時才重抓，每次執行最多用 P["fund_budget"] 次請求。

評分
- 書中基本面分（0~3，依《超級績效》SEPA 的基本面要求；門檻 25% 取自歐尼爾，屬於量化假設）
  F1 最近一季 EPS 年增 ≥ 25%
  F2 EPS 年增率加速（最近一季年增率 > 前一季年增率）
  F3 營收年增 ≥ 20% 且營業利益率比去年同季高（利潤率擴張）
- 循環分（0~3，依使用者的循環課框架自行量化）
  C1 月營收加速：最近 1 個月年增率 ≥ 15% 且 > 前 3 個月年增率平均
  C2 毛利率翻揚：最近一季毛利率 > 前 4 季平均 + 2 個百分點
  C3 月營收創 24 個月新高
- 擴產標籤（只提示，不計分）
  capex：最近一季資本支出年增 ≥ 30% → 「擴產中」；連續 3 季以上 → 「循環後段」
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import requests

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
UA = {"User-Agent": "Mozilla/5.0 (stock-screener; personal use)"}

FP = {
    "fund_budget": 300,        # 每次執行最多打幾次 FinMind
    "eps_yoy_min": 0.25,       # F1
    "rev_q_yoy_min": 0.20,     # F3
    "mrev_yoy_min": 0.15,      # C1
    "gm_uptick_pp": 2.0,       # C2（百分點）
    "mrev_high_months": 24,    # C3
    "capex_yoy_min": 0.30,     # 擴產
    "capex_late_q": 3,         # 連續幾季算循環後段
}

# FinMind 各欄位可能的英文 type 與中文名稱（兩者擇一符合即可）
TYPES = {
    "eps": (("EPS",), ("基本每股盈餘",)),
    "revenue": (("Revenue", "OperatingRevenue"), ("營業收入",)),
    "gross": (("GrossProfit",), ("營業毛利",)),
    "opinc": (("OperatingIncome",), ("營業利益",)),
    "capex": (("PropertyAndPlantAndEquipment", "AcquisitionOfPropertyPlantAndEquipment"), ("取得不動產",)),
    "dep": (("Depreciation", "DepreciationExpense"), ("折舊",)),
}


def log(*a):
    print(*a, flush=True)


class Budget:
    def __init__(self, n: int):
        self.left = n
        self.used = 0


def _get(dataset: str, sid: str, start: str, budget: Budget) -> list[dict] | None:
    if budget.left <= 0:
        return None
    budget.left -= 1
    budget.used += 1
    headers = dict(UA)
    tok = os.getenv("FINMIND_TOKEN", "").strip()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    for attempt in range(2):
        try:
            r = requests.get(FINMIND_URL, params={"dataset": dataset, "data_id": sid, "start_date": start},
                             headers=headers, timeout=30)
            if r.status_code == 402:           # 額度用完
                log("⚠️ FinMind 額度用完，這次先停止抓基本面")
                budget.left = 0
                return None
            r.raise_for_status()
            return r.json().get("data", [])
        except Exception as e:  # noqa: BLE001
            if attempt == 1:
                log(f"  FinMind {dataset} {sid} 失敗：{e}")
            time.sleep(1.5)
    return None


def _pick(rows: list[dict], key: str) -> dict[str, float]:
    """從長表格挑出某一項，回傳 {日期: 數值}"""
    types, names = TYPES[key]
    out: dict[str, float] = {}
    for r in rows:
        t, n = str(r.get("type", "")), str(r.get("origin_name", ""))
        if t in types or any(n.startswith(x) or x in n for x in names):
            d = str(r.get("date", ""))[:10]
            if d and d not in out:
                try:
                    out[d] = float(r.get("value"))
                except (TypeError, ValueError):
                    pass
    return out


# ---------------------------------------------------------------- 何時該有新資料
def expected_month(today: dt.date) -> str:
    """最新應該公布的月營收月份（每月 10 日前公布上個月）"""
    y, m = today.year, today.month - (1 if today.day > 10 else 2)
    while m <= 0:
        m += 12
        y -= 1
    return f"{y}-{m:02d}"


def expected_quarter(today: dt.date) -> str:
    """最新應該公布的季報（季底日期）。期限：Q1 5/15、Q2 8/14、Q3 11/14、Q4 隔年 3/31"""
    y = today.year
    md = (today.month, today.day)
    if md > (11, 14):
        return f"{y}-09-30"
    if md > (8, 14):
        return f"{y}-06-30"
    if md > (5, 15):
        return f"{y}-03-31"
    if md > (3, 31):
        return f"{y - 1}-12-31"
    return f"{y - 1}-09-30"


def _age_days(ts: str | None, today: dt.date) -> float:
    if not ts:
        return 9999
    try:
        return (today - dt.date.fromisoformat(ts[:10])).days
    except ValueError:
        return 9999


# ---------------------------------------------------------------- 抓取與快取
def refresh(sid: str, cache: dict, today: dt.date, budget: Budget) -> dict:
    start_m = (today.replace(day=1) - dt.timedelta(days=365 * 3)).isoformat()
    start_q = (today - dt.timedelta(days=365 * 4)).isoformat()

    # 月營收：還沒拿到應公布的月份，且距離上次抓超過 1 天
    mrev = cache.get("mrev", {})
    last_m = max(mrev) if mrev else ""
    if last_m < expected_month(today) and _age_days(cache.get("mrev_ts"), today) >= 1:
        rows = _get("TaiwanStockMonthRevenue", sid, start_m, budget)
        if rows is not None:
            new = {}
            for r in rows:
                try:
                    k = f"{int(r['revenue_year'])}-{int(r['revenue_month']):02d}"
                    new[k] = float(r["revenue"])
                except (KeyError, TypeError, ValueError):
                    pass
            if new:
                cache["mrev"] = dict(sorted(new.items()))
            cache["mrev_ts"] = today.isoformat()

    # 季報：還沒拿到應公布的季度（或完全沒資料），且距離上次抓超過 3 天
    q = cache.get("q", {})
    last_q = max(q.get("eps", {})) if q.get("eps") else ""
    if last_q < expected_quarter(today) and _age_days(cache.get("q_ts"), today) >= 3:
        fin = _get("TaiwanStockFinancialStatements", sid, start_q, budget)
        cf = _get("TaiwanStockCashFlowsStatement", sid, start_q, budget) if fin is not None else None
        if fin is not None:
            cache["q"] = {k: dict(sorted(_pick(fin, k).items())) for k in ("eps", "revenue", "gross", "opinc")}
            if cf is not None:
                cache["q"]["capex"] = dict(sorted(_pick(cf, "capex").items()))
                cache["q"]["dep"] = dict(sorted(_pick(cf, "dep").items()))
                if not cache["q"]["capex"]:
                    log(f"  {sid} 現金流量表找不到資本支出，type 範例：{sorted({r.get('type') for r in cf})[:15]}")
            if not cache["q"]["eps"]:
                log(f"  {sid} 損益表找不到 EPS，type 範例：{sorted({r.get('type') for r in fin})[:15]}")
            cache["q_ts"] = today.isoformat()
    return cache


# ---------------------------------------------------------------- 計算
def _yoy(series: dict[str, float], key: str, lag_key: str) -> float | None:
    a, b = series.get(key), series.get(lag_key)
    if a is None or b is None or b <= 0:
        return None
    return a / b - 1


def _lag_year(d: str) -> str:
    return f"{int(d[:4]) - 1}{d[4:]}"


def _qtr_ytd_to_single(series: dict[str, float]) -> dict[str, float]:
    """現金流量表是「年初至今累計」，轉成單季。
    保險起見先檢查：若同一年內數字沒有逐季變大（絕對值），代表已經是單季，直接回傳"""
    ks = sorted(series)
    same_year = [(a, b) for a, b in zip(ks, ks[1:]) if a[:4] == b[:4]]
    if same_year and sum(abs(series[b]) >= abs(series[a]) for a, b in same_year) < len(same_year) * 0.8:
        return dict(series)
    out = {}
    for d in sorted(series):
        m = d[5:7]
        if m == "03":
            out[d] = series[d]
        else:
            prev_m = {"06": "03", "09": "06", "12": "09"}.get(m)
            prev = series.get(f"{d[:4]}-{prev_m}-" + {"03": "31", "06": "30", "09": "30"}[prev_m]) if prev_m else None
            if prev is not None:
                out[d] = series[d] - prev
    return out


def evaluate(cache: dict) -> dict:
    res: dict = {"f": {}, "c": {}, "tags": []}
    q = cache.get("q", {})
    eps, rev, gross, opinc = (q.get(k, {}) for k in ("eps", "revenue", "gross", "opinc"))

    # ---- 季資料
    qs = sorted(eps)
    if qs:
        last = qs[-1]
        y1 = _yoy_eps(eps, last)
        y0 = _yoy_eps(eps, qs[-2]) if len(qs) >= 2 else None
        res["q_last"] = last
        res["eps"] = eps[last]
        res["eps_yoy"] = _pct(y1)
        res["eps_yoy_prev"] = _pct(y0)
        res["f"]["f1"] = bool(y1 is not None and y1 >= FP["eps_yoy_min"])
        res["f"]["f2"] = bool(y1 is not None and y0 is not None and y1 > y0)
        ry = _yoy(rev, last, _lag_year(last))
        om = _margin(opinc, rev, last)
        om_ly = _margin(opinc, rev, _lag_year(last))
        res["rev_q_yoy"] = _pct(ry)
        res["op_margin"] = _pp(om)
        res["op_margin_ly"] = _pp(om_ly)
        res["f"]["f3"] = bool(ry is not None and ry >= FP["rev_q_yoy_min"] and om is not None and om_ly is not None and om > om_ly)

        gms = [(_margin(gross, rev, d)) for d in qs[-5:]]
        gm_last = gms[-1] if gms else None
        prev4 = [g for g in gms[:-1] if g is not None]
        res["gm"] = _pp(gm_last)
        res["gm_avg4"] = _pp(sum(prev4) / len(prev4)) if prev4 else None
        res["c"]["c2"] = bool(gm_last is not None and len(prev4) >= 3
                              and gm_last * 100 > sum(prev4) / len(prev4) * 100 + FP["gm_uptick_pp"])
        # 給網站畫圖：近 12 季
        res["q_hist"] = [{"q": d, "eps": eps.get(d), "gm": _pp(_margin(gross, rev, d)),
                          "om": _pp(_margin(opinc, rev, d))} for d in qs[-12:]]

    # ---- 資本支出（取絕對值；現金流量表為負數）
    capex = {d: abs(v) for d, v in _qtr_ytd_to_single(q.get("capex", {})).items()}
    dep = {d: abs(v) for d, v in _qtr_ytd_to_single(q.get("dep", {})).items()}
    if capex:
        streak = 0
        for d in sorted(capex, reverse=True):
            y = _yoy(capex, d, _lag_year(d))
            if y is not None and y >= FP["capex_yoy_min"]:
                streak += 1
            else:
                break
        cl = max(capex)
        res["capex_yoy"] = _pct(_yoy(capex, cl, _lag_year(cl)))
        res["capex_streak"] = streak
        if streak >= FP["capex_late_q"]:
            res["tags"].append("循環後段")
        elif streak >= 1:
            res["tags"].append("擴產中")
        if res.get("q_hist"):
            for h in res["q_hist"]:
                h["capex"] = round(capex[h["q"]] / 1e8, 2) if h["q"] in capex else None
                h["dep"] = round(dep[h["q"]] / 1e8, 2) if h["q"] in dep else None

    # ---- 月營收
    mrev = cache.get("mrev", {})
    ms = sorted(mrev)
    if len(ms) >= 13:
        yoys = []
        for m in ms[-24:]:
            ly = f"{int(m[:4]) - 1}{m[4:]}"
            yoys.append((m, _yoy(mrev, m, ly)))
        last_m, y_last = yoys[-1]
        prev3 = [y for _, y in yoys[-4:-1] if y is not None]
        res["m_last"] = last_m
        res["mrev_yoy"] = _pct(y_last)
        res["mrev_yoy_prev3"] = _pct(sum(prev3) / len(prev3)) if prev3 else None
        res["c"]["c1"] = bool(y_last is not None and prev3 and y_last >= FP["mrev_yoy_min"]
                              and y_last > sum(prev3) / len(prev3))
        win = [mrev[m] for m in ms[-FP["mrev_high_months"]:]]
        res["c"]["c3"] = bool(len(win) >= 13 and mrev[last_m] >= max(win))
        if res["c"]["c3"]:
            res["tags"].append("營收新高")
        # 營收趨勢：好轉紅／轉壞綠／持平灰（仿優分析）
        if res["c"]["c1"]:
            res["mrev_trend"] = "up"
        elif y_last is not None and prev3 and y_last < 0 and y_last < sum(prev3) / len(prev3):
            res["mrev_trend"] = "down"
        else:
            res["mrev_trend"] = "flat"
        res["m_hist"] = [{"m": m, "rev": round(mrev[m] / 1e8, 2), "yoy": _pct(y)} for m, y in yoys]

    res["fscore"] = sum(res["f"].values())
    res["cscore"] = sum(res["c"].values())
    res["has_q"] = bool(qs)
    res["has_m"] = len(ms) >= 13
    return res


def _yoy_eps(eps: dict[str, float], d: str) -> float | None:
    """EPS 年增率；去年同期 ≤ 0 時，今年轉正視為大幅成長（+100%），否則無法計算"""
    a, b = eps.get(d), eps.get(_lag_year(d))
    if a is None or b is None:
        return None
    if b <= 0:
        return 1.0 if a > 0 else None
    return a / b - 1


def _margin(num: dict[str, float], den: dict[str, float], d: str) -> float | None:
    a, b = num.get(d), den.get(d)
    if a is None or not b:
        return None
    return a / b


def _pct(x: float | None) -> float | None:
    return None if x is None else round(x * 100, 1)


def _pp(x: float | None) -> float | None:
    return None if x is None else round(x * 100, 1)


# ---------------------------------------------------------------- 對外介面
def attach(stocks: list[dict], out_dir: Path, today: dt.date | None = None, budget_n: int | None = None) -> dict:
    """替上榜股票加上基本面欄位；回傳統計"""
    today = today or dt.date.today()
    fdir = out_dir / "fund"
    fdir.mkdir(parents=True, exist_ok=True)
    budget = Budget(FP["fund_budget"] if budget_n is None else budget_n)
    if not os.getenv("FINMIND_TOKEN", "").strip():
        budget.left = min(budget.left, 60)
        log("⚠️ 沒有 FINMIND_TOKEN，基本面每次只補抓少量股票（請到 GitHub Secrets 設定）")

    # 先抓評分高、突破的
    order = sorted(stocks, key=lambda s: (s.get("breakout", False), s.get("score", 0), s.get("rs", 0)), reverse=True)
    done = 0
    for s in order:
        p = fdir / f"{s['id']}.json"
        try:
            cache = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        except Exception:  # noqa: BLE001
            cache = {}
        before = json.dumps(cache, sort_keys=True)
        if budget.left > 0:
            cache = refresh(s["id"], cache, today, budget)
        if json.dumps(cache, sort_keys=True) != before:
            p.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        ev = evaluate(cache)
        s["fund"] = {k: ev[k] for k in ("fscore", "cscore", "f", "c", "tags", "has_q", "has_m") }
        for k in ("eps_yoy", "rev_q_yoy", "gm", "mrev_yoy", "mrev_trend", "capex_yoy", "q_last", "m_last"):
            if k in ev:
                s["fund"][k] = ev[k]
        s["fund"]["m12"] = [h["yoy"] for h in ev.get("m_hist", [])[-12:]]   # 表格迷你圖用
        # 圖表資料另外存，減少 latest.json 體積
        (fdir / f"{s['id']}.view.json").write_text(
            json.dumps({"m_hist": ev.get("m_hist", []), "q_hist": ev.get("q_hist", []), **{k: ev.get(k) for k in (
                "eps", "eps_yoy", "eps_yoy_prev", "rev_q_yoy", "op_margin", "op_margin_ly", "gm", "gm_avg4",
                "mrev_yoy", "mrev_yoy_prev3", "capex_yoy", "capex_streak", "q_last", "m_last")}},
                       ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if ev["has_q"] or ev["has_m"]:
            done += 1
    log(f"基本面：{done}/{len(stocks)} 檔有資料；本次 FinMind 請求 {budget.used} 次")
    return {"with_data": done, "requests": budget.used}
