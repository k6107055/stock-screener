"""
歷史回測：用過去約 6 年的資料，每天套用與每日篩選相同的規則，
出現「買進訊號」就用賣出規則 A 模擬交易，並比較不同參數。

買進訊號（基本版）= 趨勢模板 8 條全過 + 今日突破 + 型態評分 ≥ 3 + 停損距離 ≤ 8% + 大盤多頭
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import screener as S  # noqa: E402
from sim import FEE, TAX, fnum, simulate_trade, trade_stats  # noqa: E402

OUT = S.ROOT / "docs" / "data" / "backtest"
P = S.P
YEARS = 7            # 下載年數（前 1 年多用來暖機算 200 日線、一年高低點）
CAPITAL = 1_000_000  # 模擬資金
RISK_PCT = 0.01      # 每筆最多虧總資金 1%
MAX_POS_PCT = 0.25   # 單檔上限 25%

VARIANTS = [
    # key, 名稱, 說明, 參數
    ("base", "基本版", "評分≥3、停損≤8%、停損用近10日低點、大盤多頭才進場",
     dict(min_score=3, risk_max=0.08, stop_lb=10, mkt_filter=True)),
    ("score4", "只做 4 條全過", "評分要 4 條全過，其餘同基本版",
     dict(min_score=4, risk_max=0.08, stop_lb=10, mkt_filter=True)),
    ("score2", "評分≥2", "放寬到 2 條，其餘同基本版",
     dict(min_score=2, risk_max=0.08, stop_lb=10, mkt_filter=True)),
    ("anybo", "只要突破", "不看型態評分，只要趨勢模板＋突破",
     dict(min_score=0, risk_max=0.08, stop_lb=10, mkt_filter=True)),
    ("risk10", "停損放寬到 10%", "停損距離上限 10%，其餘同基本版",
     dict(min_score=3, risk_max=0.10, stop_lb=10, mkt_filter=True)),
    ("stop15", "停損用近15日低點", "停損改抓近 15 日最低價，其餘同基本版",
     dict(min_score=3, risk_max=0.08, stop_lb=15, mkt_filter=True)),
    ("nomkt", "不看大盤", "大盤轉弱也照樣進場，其餘同基本版",
     dict(min_score=3, risk_max=0.08, stop_lb=10, mkt_filter=False)),
]


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 資料
def build_panel(universe: pd.DataFrame, prices: dict, idx: pd.DataFrame):
    dates = pd.DatetimeIndex(sorted({d.date() for d in idx.index}))
    fields = {k: {} for k in ("Open", "High", "Low", "Close", "Volume")}
    meta = {}
    for _, u in universe.iterrows():
        t = u["id"] + (".TW" if u["market"] == "twse" else ".TWO")
        df = prices.get(t)
        if df is None or len(df) < P["min_rows"]:
            continue
        d = df.copy()
        d.index = pd.DatetimeIndex([x.date() for x in d.index])
        d = d[~d.index.duplicated(keep="last")].reindex(dates)
        for k in fields:
            fields[k][u["id"]] = d[k].astype(float)
        meta[u["id"]] = {"name": u["name"], "industry": u["industry"],
                         "ex": "TPEX" if u["market"] == "tpex" else "TWSE"}
    panel = {k: pd.DataFrame(v, index=dates) for k, v in fields.items()}
    ic = idx["Close"].astype(float).copy()
    ic.index = pd.DatetimeIndex([x.date() for x in ic.index])
    ic = ic[~ic.index.duplicated(keep="last")].reindex(dates).ffill()
    return panel, meta, ic


def indicators(pn: dict, ic: pd.Series) -> dict:
    """與 screener.analyze / score 相同的規則，改成一次算整個面板（日期 × 股票）"""
    O, H, L, C, V = (pn[k] for k in ("Open", "High", "Low", "Close", "Volume"))
    ma50, ma150, ma200 = (C.rolling(n).mean() for n in (50, 150, 200))
    hi252, lo252 = H.rolling(252).max(), L.rolling(252).min()
    ret = lambda k: C / C.shift(k) - 1  # noqa: E731
    rs_raw = 0.4 * ret(63) + 0.2 * ret(126) + 0.2 * ret(189) + 0.2 * ret(251)
    turn20 = (C * V).rolling(20).mean()
    valid = (C.notna().cumsum() >= P["min_rows"]) & (turn20 >= P["min_turnover"]) & C.notna()
    rs = (rs_raw.where(valid).rank(axis=1, pct=True) * 98 + 1).round()

    trend = ((C > ma150) & (C > ma200) & (ma150 > ma200) & (ma200 > ma200.shift(21))
             & (ma50 > ma150) & (ma50 > ma200) & (C > ma50)
             & (C >= lo252 * P["low_mult"]) & (C >= hi252 * P["high_ratio"]) & (rs >= P["rs_min"]))

    ph, pl, pv = H.shift(1), L.shift(1), V.shift(1)

    def rng(win, lag):
        hh, ll = ph.shift(lag).rolling(win).max(), pl.shift(lag).rolling(win).min()
        return (hh - ll) / ll

    r1, r2, r3 = rng(10, 0), rng(20, 10), rng(40, 30)
    vol50, vol10 = pv.rolling(50).mean(), pv.rolling(10).mean()
    pivot = ph.rolling(10).max()
    ret20 = ret(20)

    rule1 = ((C / ma50 - 1) <= P["ext_ma50_max"]) & (ret20 <= P["ret20_max"])
    rule2 = ((C / hi252 - 1) >= -P["near_high"]) & (C <= pivot * (1 + P["above_pivot_max"]))
    rule3 = (r1 < r2) & (r2 < r3) & (r1 <= P["last_range_max"])
    rule4 = vol10 < vol50 * P["dry_ratio"]
    score = rule1.astype(int) + rule2.astype(int) + rule3.astype(int) + rule4.astype(int)

    day_rng = H - L
    close_pos = ((C - L) / day_rng).where(day_rng > 0, 1.0)
    breakout = (C > pivot) & (V >= P["bo_vol_ratio"] * vol50) & (close_pos >= 0.5)

    im50, im200 = ic.rolling(50).mean(), ic.rolling(200).mean()
    mkt_ok = (ic > im50) & (ic > im200)

    stops = {lb: pl.rolling(lb).min() for lb in (10, 15)}
    return dict(O=O, H=H, L=L, C=C, ma50=ma50, rs=rs, trend=trend & valid, score=score,
                breakout=breakout, pivot=pivot, stops=stops, mkt_ok=mkt_ok,
                rules=(rule1, rule2, rule3, rule4))


# ---------------------------------------------------------------- 回測
def gen_trades(ind: dict, meta: dict, vp: dict, start_i: int) -> tuple[list, dict]:
    C = ind["C"]
    dates = C.index
    stop = ind["stops"][vp["stop_lb"]]
    entry_ref = np.maximum(ind["pivot"], C)
    risk_sig = (entry_ref - stop) / entry_ref
    sig = ind["trend"] & ind["breakout"] & (ind["score"] >= vp["min_score"]) & (risk_sig <= vp["risk_max"])
    if vp["mkt_filter"]:
        sig = sig & ind["mkt_ok"].to_numpy()[:, None]
    sig.iloc[:start_i] = False

    trades, skips = [], {"gap": 0, "chase": 0, "risk": 0}
    arr = {k: ind[k].to_numpy() for k in ("O", "H", "L", "C", "ma50", "score", "rs")}
    stop_a, piv_a, sig_a = stop.to_numpy(), ind["pivot"].to_numpy(), sig.to_numpy()
    for j, sid in enumerate(C.columns):
        idxs = np.flatnonzero(sig_a[:, j])
        if not len(idxs):
            continue
        o, h, l, c, m50 = (arr[k][:, j] for k in ("O", "H", "L", "C", "ma50"))
        busy_until = -1
        for i in idxs:
            if i <= busy_until:
                continue
            res = simulate_trade(o, h, l, c, m50, int(i), float(stop_a[i, j]), float(piv_a[i, j]),
                                 risk_max=vp["risk_max"])
            if res["status"] == "skip":
                skips[res["reason"]] += 1
                continue
            if res["status"] == "pending":
                continue
            busy_until = res["exit_i"]
            m = meta[sid]
            trades.append({
                "id": sid, "name": m["name"], "ex": m["ex"], "industry": m["industry"],
                "sig": dates[i].date().isoformat(),
                "in": dates[res["entry_i"]].date().isoformat(),
                "out": dates[res["exit_i"]].date().isoformat(),
                "be": dates[res["be_i"]].date().isoformat() if res["be_i"] is not None else None,
                "entry": res["entry"], "exit": res["exit"], "stop": res["stop"],
                "pivot": fnum(piv_a[i, j]), "r": res["r"], "pct": res["pct"], "days": res["days"],
                "reason": res["reason"], "status": res["status"],
                "score": int(arr["score"][i, j]), "rs": int(arr["rs"][i, j]) if not np.isnan(arr["rs"][i, j]) else None,
                "_ei": res["entry_i"], "_xi": res["exit_i"], "_j": j,
            })
    trades.sort(key=lambda t: (t["in"], -(t["rs"] or 0)))
    return trades, skips


def portfolio(trades: list, C: pd.DataFrame, start_i: int) -> dict:
    """依時間順序模擬實際資金：每筆最多虧 1%，單檔上限 25%，錢不夠就跳過"""
    closes = C.ffill().to_numpy()
    dates = C.index
    by_entry: dict[int, list] = {}
    for k, t in enumerate(trades):
        by_entry.setdefault(t["_ei"], []).append(k)
    cash, pos = float(CAPITAL), {}   # pos: k -> shares
    equity = []
    taken = set()
    for d in range(start_i, len(dates)):
        # 出場
        for k in [k for k in pos if trades[k]["_xi"] == d and trades[k]["status"] == "closed"]:
            cash += pos.pop(k) * trades[k]["exit"] * (1 - FEE - TAX)
        mtm = equity[-1] if equity else float(CAPITAL)   # 用前一天收盤的總資產決定部位大小
        # 進場
        held = {trades[k]["id"] for k in pos}
        for k in by_entry.get(d, []):
            t = trades[k]
            if t["id"] in held:
                continue
            risk = t["entry"] - t["stop"]
            sh = math.floor(mtm * RISK_PCT / risk)
            sh = min(sh, math.floor(mtm * MAX_POS_PCT / t["entry"]), math.floor(cash / (t["entry"] * (1 + FEE))))
            if sh < 1:
                continue
            cash -= sh * t["entry"] * (1 + FEE)
            pos[k] = sh
            taken.add(k)
            held.add(t["id"])
        eq = cash + sum(sh * closes[d, trades[k]["_j"]] for k, sh in pos.items())
        equity.append(eq)
    eq = np.array(equity)
    return {"equity": eq, "taken": taken, "dates": dates[start_i:]}



def curve_stats(eq: np.ndarray, dates) -> dict:
    yrs = (dates[-1] - dates[0]).days / 365.25
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1
    s = pd.Series(eq, index=dates)
    yearly = {str(y): round((g.iloc[-1] / s[s.index < g.index[0]].iloc[-1] - 1) * 100, 1)
              if (s.index < g.index[0]).any() else round((g.iloc[-1] / g.iloc[0] - 1) * 100, 1)
              for y, g in s.groupby(s.index.year)}
    return {
        "final": round(float(eq[-1])), "total": round((eq[-1] / eq[0] - 1) * 100, 1),
        "cagr": round(((eq[-1] / eq[0]) ** (1 / yrs) - 1) * 100, 1) if yrs > 0 else None,
        "maxdd": round(float(dd.min()) * 100, 1), "yearly": yearly,
    }


def split_stats(trades, split_date):
    a = [t for t in trades if t["in"] < split_date]
    b = [t for t in trades if t["in"] >= split_date]
    return trade_stats(a), trade_stats(b)


# ---------------------------------------------------------------- 輸出
def write_charts(trades: list, ind: dict, meta: dict):
    cdir = OUT / "charts"
    cdir.mkdir(parents=True, exist_ok=True)
    for f in cdir.glob("*.json"):
        f.unlink()
    C = ind["C"]
    dates = C.index
    by_stock: dict[str, list] = {}
    for t in trades:
        by_stock.setdefault(t["id"], []).append(t)
    r = lambda a: [None if (x is None or np.isnan(x)) else round(float(x), 2) for x in a]  # noqa: E731
    for sid, ts in by_stock.items():
        j = ts[0]["_j"]
        a = max(0, min(t["_ei"] for t in ts) - 90)
        b = min(len(dates) - 1, max(t["_xi"] for t in ts) + 15)
        rows = [k for k in range(a, b + 1) if not np.isnan(ind["C"].iat[k, j])]
        pick = lambda df: [df.iat[k, j] for k in rows]  # noqa: E731
        data = {
            "t": [dates[k].date().isoformat() for k in rows],
            "o": r(pick(ind["O"])), "h": r(pick(ind["H"])), "l": r(pick(ind["L"])), "c": r(pick(ind["C"])),
            "ma50": r(pick(ind["ma50"])),
        }
        (cdir / f"{sid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


def run_backtest(universe, prices, idx) -> dict:
    pn, meta, ic = build_panel(universe, prices, idx)
    log(f"面板：{pn['Close'].shape[0]} 天 × {pn['Close'].shape[1]} 檔")
    ind = indicators(pn, ic)
    dates = ind["C"].index
    start_i = 260
    split_i = start_i + int((len(dates) - start_i) * 0.6)
    split_date = dates[split_i].date().isoformat()

    out = {
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="minutes"),
        "start": dates[start_i].date().isoformat(), "end": dates[-1].date().isoformat(),
        "split": split_date, "stocks": int(pn["Close"].shape[1]),
        "capital": CAPITAL, "risk_pct": RISK_PCT * 100, "variants": [],
    }
    bench = ic.iloc[start_i:].to_numpy()
    bench_eq = bench / bench[0] * CAPITAL
    curve_dates = dates[start_i:]
    out["bench"] = curve_stats(bench_eq, curve_dates)
    curves = {"t": [d.date().isoformat() for d in curve_dates], "bench": [round(x) for x in bench_eq]}

    base_trades = None
    for key, name, desc, vp in VARIANTS:
        t0 = time.time()
        trades, skips = gen_trades(ind, meta, vp, start_i)
        pf = portfolio(trades, ind["C"], start_i)
        s_in, s_out = split_stats(trades, split_date)
        taken = [trades[k] for k in sorted(pf["taken"])]
        out["variants"].append({
            "key": key, "name": name, "desc": desc, "params": vp,
            "stats": trade_stats(trades), "stats_in": s_in, "stats_out": s_out,
            "taken_stats": trade_stats(taken), "skips": skips,
            "portfolio": curve_stats(pf["equity"], pf["dates"]),
        })
        curves[key] = [round(x) for x in pf["equity"]]
        log(f"[{name}] 交易 {len(trades)} 筆，實際資金可做 {len(taken)} 筆，"
            f"勝率 {out['variants'][-1]['stats'].get('win_rate')}%，"
            f"期望值 {out['variants'][-1]['stats'].get('expectancy')}%/筆，"
            f"年化 {out['variants'][-1]['portfolio']['cagr']}%，最大回撤 {out['variants'][-1]['portfolio']['maxdd']}%"
            f"（{time.time() - t0:.0f} 秒）")
        if key == "base":
            base_trades = trades
            for k, t in enumerate(trades):
                t["taken"] = k in pf["taken"]

    OUT.mkdir(parents=True, exist_ok=True)
    write_charts(base_trades, ind, meta)
    clean = [{k: v for k, v in t.items() if not k.startswith("_")} for t in base_trades]
    (OUT / "trades.json").write_text(json.dumps(clean, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "curves.json").write_text(json.dumps(curves, separators=(",", ":")), encoding="utf-8")
    (OUT / "summary.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"已輸出回測結果到 {OUT}")
    return out


def main() -> int:
    start = (dt.date.today() - dt.timedelta(days=int(365.25 * YEARS))).isoformat()
    universe = S.get_universe()
    idx = S.download_index(start=start)
    tickers = [i + (".TW" if m == "twse" else ".TWO") for i, m in zip(universe["id"], universe["market"])]
    prices = S.download_prices(tickers, start=start)
    log(f"股價下載完成：{len(prices)}/{len(tickers)}")
    if len(prices) < len(tickers) * 0.5:
        log("⚠️ 下載成功率太低，停止")
        return 1
    run_backtest(universe, prices, idx)
    return 0


if __name__ == "__main__":
    sys.exit(main())
