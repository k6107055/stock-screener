"""
交易模擬（回測與每日追蹤共用，確保兩邊規則完全一致）

賣出規則 A：
1. 訊號日隔天開盤買進
   - 開盤已低於停損 → 不買（gap）
   - 開盤高於樞紐點 5% 以上 → 不追（chase）
   - 以實際買價計算的停損距離 > 上限 → 不買（risk）
2. 盤中碰到停損價就賣（若開盤就跳空跌破，以開盤價賣）
3. 最高價碰到「買價 + 2 倍風險」後，停損上移到買價（保本）
4. 保本後，收盤跌破 50 日線 → 隔天開盤賣出
交易成本：買進手續費 0.1425%，賣出手續費 0.1425% + 證交稅 0.3%
"""
from __future__ import annotations

import math

import numpy as np

FEE = 0.001425
TAX = 0.003


def net_return(entry: float, exit_: float) -> float:
    cost_in = entry * (1 + FEE)
    cash_out = exit_ * (1 - FEE - TAX)
    return cash_out / cost_in - 1


def simulate_trade(o, h, l, c, ma50, i_sig: int, stop: float, pivot: float,
                   risk_max: float = 0.08, chase_max: float = 0.05, be_mult: float = 2.0) -> dict:
    """
    o/h/l/c/ma50：單一股票的 numpy 陣列（同一組日期）
    i_sig：訊號日的索引；隔天開盤買進
    回傳 dict：status = skip / pending / open / closed
    """
    n = len(c)
    i = i_sig + 1
    if i >= n or np.isnan(o[i]):
        return {"status": "pending"}
    entry = float(o[i])
    if not (stop > 0) or entry <= stop:
        return {"status": "skip", "reason": "gap", "entry_i": i}
    if pivot > 0 and entry > pivot * (1 + chase_max):
        return {"status": "skip", "reason": "chase", "entry_i": i}
    risk = entry - stop
    if risk / entry > risk_max:
        return {"status": "skip", "reason": "risk", "entry_i": i}

    cur_stop = stop
    be = False
    be_i = None
    for j in range(i, n):
        if np.isnan(c[j]):
            continue
        # 1) 停損（含保本停損）
        if l[j] <= cur_stop:
            px = float(o[j]) if (j > i and o[j] < cur_stop) else cur_stop
            return _closed(entry, px, i, j, "breakeven" if be else "stop", risk, stop, be_i)
        # 2) 保本
        if not be and h[j] >= entry + be_mult * risk:
            be, be_i = True, j
            cur_stop = max(cur_stop, entry)
        # 3) 保本後跌破 50 日線，隔天開盤賣
        if be and not np.isnan(ma50[j]) and c[j] < ma50[j]:
            k = j + 1
            while k < n and np.isnan(o[k]):
                k += 1
            if k >= n:
                return _open(entry, c, i, n, risk, stop, be_i, exit_pending=True)
            return _closed(entry, float(o[k]), i, k, "ma50", risk, stop, be_i)
    return _open(entry, c, i, n, risk, stop, be_i)


def _closed(entry, px, i, j, reason, risk, stop, be_i):
    return {
        "status": "closed", "reason": reason, "entry_i": i, "exit_i": j,
        "entry": round(entry, 2), "exit": round(px, 2), "stop": round(stop, 2),
        "r": round((px - entry) / risk, 2), "pct": round(net_return(entry, px) * 100, 2),
        "days": j - i, "be_i": be_i,
    }


def _open(entry, c, i, n, risk, stop, be_i, exit_pending=False):
    last = n - 1
    while last > i and np.isnan(c[last]):
        last -= 1
    px = float(c[last])
    return {
        "status": "open", "reason": "ma50_next_open" if exit_pending else "holding",
        "entry_i": i, "exit_i": last, "entry": round(entry, 2), "exit": round(px, 2),
        "stop": round(stop, 2), "r": round((px - entry) / risk, 2),
        "pct": round(net_return(entry, px) * 100, 2), "days": last - i, "be_i": be_i,
    }


def trade_stats(trades: list[dict]) -> dict:
    """trades：含 pct、r、days 的交易清單（已平倉＋未平倉以最新價計）"""
    if not trades:
        return {"n": 0}
    pct = np.array([t["pct"] for t in trades], float)
    r = np.array([t["r"] for t in trades], float)
    days = np.array([t["days"] for t in trades], float)
    win = pct > 0
    avg_win = float(pct[win].mean()) if win.any() else 0.0
    avg_loss = float(pct[~win].mean()) if (~win).any() else 0.0
    # 最長連續虧損
    streak = best = 0
    for w in win:
        streak = 0 if w else streak + 1
        best = max(best, streak)
    return {
        "n": int(len(pct)),
        "win_rate": round(float(win.mean()) * 100, 1),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "payoff": round(avg_win / abs(avg_loss), 2) if avg_loss else None,
        "expectancy": round(float(pct.mean()), 2),       # 每筆平均報酬 %
        "avg_r": round(float(r.mean()), 2),
        "median_pct": round(float(np.median(pct)), 2),
        "best": round(float(pct.max()), 2), "worst": round(float(pct.min()), 2),
        "avg_days": round(float(days.mean()), 1),
        "max_losing_streak": int(best),
        "big_wins": int((r >= 3).sum()),                 # 賺 3R 以上的筆數
    }


def fnum(x, nd=2):
    if x is None:
        return None
    x = float(x)
    return None if (math.isnan(x) or math.isinf(x)) else round(x, nd)
