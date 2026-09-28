"""
每日追蹤（從系統上線日開始的「真實」紀錄，沒有事後調整的空間）

1. 買進訊號：與回測「基本版」相同條件（趨勢模板＋突破＋評分≥3＋停損≤8%＋大盤多頭），
   記錄下來後用賣出規則 A 模擬交易，每天更新狀態
2. 觀察名單：每天評分≥3 的股票，追蹤 5／10／20／60 個交易日後的漲跌，與大盤比較
"""
from __future__ import annotations

import datetime as dt
import json

import numpy as np
import pandas as pd

from sim import simulate_trade, trade_stats

MIN_SCORE = 3
HORIZONS = (5, 10, 20, 60)


def _load(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _series(df: pd.DataFrame):
    d = df.copy()
    d.index = [x.date().isoformat() for x in d.index]
    d = d[~d.index.duplicated(keep="last")]
    ma50 = d["Close"].astype(float).rolling(50).mean()
    return d, ma50


def update(result: dict, prices: dict, idx: pd.DataFrame, out_dir, risk_max: float) -> None:
    tdir = out_dir / "tracking"
    tdir.mkdir(parents=True, exist_ok=True)
    sig_path, watch_path = tdir / "signals.json", tdir / "watch.json"
    signals = _load(sig_path, [])
    watch = _load(watch_path, [])
    today = result["date"]
    mkt = result["market"]
    mkt_ok = bool(mkt["above50"] and mkt["above200"])

    # --- 記錄今天
    seen = {(s["id"], s["sig"]) for s in signals}
    for s in result["stocks"]:
        if s["breakout"] and s["score"] >= MIN_SCORE and s["risk_ok"] and mkt_ok and (s["id"], today) not in seen:
            signals.append({"id": s["id"], "name": s["name"], "ex": s["ex"], "sig": today,
                            "pivot": s.get("pivot"), "stop": s["stop"], "score": s["score"], "rs": s["rs"]})
    watch = [w for w in watch if w["date"] != today]
    watch.append({"date": today, "mkt": mkt["close"],
                  "stocks": [[s["id"], s["name"], s["ex"], s["close"], s["score"]]
                             for s in result["stocks"] if s["score"] >= MIN_SCORE]})
    watch.sort(key=lambda w: w["date"])
    sig_path.write_text(json.dumps(signals, ensure_ascii=False), encoding="utf-8")
    watch_path.write_text(json.dumps(watch, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # --- 更新模擬交易
    cache = {}

    def get(sid, ex):
        if sid not in cache:
            df = prices.get(sid + (".TWO" if ex == "TPEX" else ".TW"))
            cache[sid] = _series(df) if df is not None else None
        return cache[sid]

    trades = []
    for s in signals:
        g = get(s["id"], s["ex"])
        row = {**s, "status": "nodata"}
        if g is not None and s["sig"] in g[0].index:
            d, ma50 = g
            i = d.index.get_loc(s["sig"])
            a = lambda k: d[k].to_numpy(float)  # noqa: E731
            res = simulate_trade(a("Open"), a("High"), a("Low"), a("Close"), ma50.to_numpy(),
                                 int(i), float(s["stop"]), float(s.get("pivot") or 0), risk_max=risk_max)
            row["status"] = res["status"]
            if "reason" in res:
                row["reason"] = res["reason"]
            if res["status"] in ("open", "closed"):
                row.update({k: res[k] for k in ("entry", "exit", "r", "pct", "days")})
                row["in"] = d.index[res["entry_i"]]
                row["out"] = d.index[res["exit_i"]] if res["status"] == "closed" else None
                row["be"] = d.index[res["be_i"]] if res["be_i"] is not None else None
        trades.append(row)

    done = [t for t in trades if t["status"] in ("open", "closed")]
    closed = [t for t in done if t["status"] == "closed"]

    # --- 觀察名單的後續表現
    ic = idx["Close"].astype(float).copy()
    ic.index = [x.date().isoformat() for x in ic.index]
    ic = ic[~ic.index.duplicated(keep="last")]
    rows, agg = [], {h: {"ret": [], "ex": []} for h in HORIZONS}
    for w in watch:
        if w["date"] not in ic.index:
            continue
        mi = ic.index.get_loc(w["date"])
        for sid, name, ex, close, score in w["stocks"]:
            g = get(sid, ex)
            if g is None or w["date"] not in g[0].index:
                continue
            d = g[0]
            i = d.index.get_loc(w["date"])
            c0 = float(d["Close"].iloc[i])
            item = {"date": w["date"], "id": sid, "name": name, "ex": ex, "score": score, "close": close}
            for h in HORIZONS:
                if i + h < len(d) and mi + h < len(ic):
                    r = float(d["Close"].iloc[i + h]) / c0 - 1
                    m = float(ic.iloc[mi + h]) / float(ic.iloc[mi]) - 1
                    item[f"r{h}"] = round(r * 100, 2)
                    agg[h]["ret"].append(r)
                    agg[h]["ex"].append(r - m)
            rows.append(item)
    horizon = {}
    for h in HORIZONS:
        r, e = np.array(agg[h]["ret"]), np.array(agg[h]["ex"])
        horizon[str(h)] = {"n": int(len(r))} if not len(r) else {
            "n": int(len(r)), "avg": round(float(r.mean()) * 100, 2),
            "win": round(float((r > 0).mean()) * 100, 1),
            "excess": round(float(e.mean()) * 100, 2),
            "beat": round(float((e > 0).mean()) * 100, 1),
        }

    # --- K 線資料（追蹤中的股票）
    cdir = tdir / "charts"
    cdir.mkdir(exist_ok=True)
    for sid in {t["id"] for t in done}:
        g = cache.get(sid)
        if g is None:
            continue
        d, ma50 = g
        d = d.iloc[-300:]
        m = ma50.iloc[-300:]
        r = lambda s: [None if pd.isna(x) else round(float(x), 2) for x in s]  # noqa: E731
        cd = {"t": list(d.index), "o": r(d["Open"]), "h": r(d["High"]), "l": r(d["Low"]),
              "c": r(d["Close"]), "ma50": r(m)}
        (cdir / f"{sid}.json").write_text(json.dumps(cd, separators=(",", ":")), encoding="utf-8")

    first = watch[0]["date"] if watch else today
    out = {
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="minutes"),
        "since": first, "date": today, "days": len(watch),
        "trades": sorted(trades, key=lambda t: t["sig"], reverse=True),
        "stats": trade_stats(done), "closed_stats": trade_stats(closed),
        "open_n": sum(t["status"] == "open" for t in done),
        "horizon": horizon,
        "watch_recent": [x for x in rows if x["date"] >= (watch[-min(len(watch), 30)]["date"] if watch else today)][-600:],
    }
    (tdir / "tracking.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"追蹤：訊號 {len(signals)} 筆（持有中 {out['open_n']}、已出場 {len(closed)}），觀察名單 {len(watch)} 天", flush=True)
