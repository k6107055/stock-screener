"""
每日選股跑完後，把結果交給 LINE 小幫手（Google Apps Script）：
- 推播今日買進訊號、新上榜高分股、主流族群給所有成員
- 買進訊號最多 3 檔自動排入「整合報告」流程
- 準備區（接近突破點）提醒
- 持股檢查：向 Apps Script 取回你用 LINE 記錄的持股，依賣出規則 A 檢查（停損、保本、跌破 50 日線）
  ※ 持股只在記憶體裡計算、直接回傳 Apps Script，不會寫進公開的 repo 或印在執行紀錄

需要 GitHub Secrets：GAS_URL（Apps Script 網址，結尾 /exec）、GAS_KEY（跟竄改猴同一串 KEY）。
沒設定就跳過，不影響選股。同一個資料日 Apps Script 只會推播一次。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://k6107055.github.io/stock-screener/"
MIN_SCORE = 3
AUTO_REPORT_MAX = 3


def fund_total(s: dict) -> int:
    f = s.get("fund") or {}
    return f.get("fscore", 0) + f.get("cscore", 0)


def brief(s: dict) -> dict:
    f = s.get("fund") or {}
    return {
        "why": s.get("why", []), "warn": s.get("warn", []), "prefer": s.get("prefer", False),
        "pivot": s.get("pivot"), "bo_lots": s.get("bo_lots"), "streak": s.get("streak"),
        "id": s["id"], "name": s["name"], "industry": s.get("industry", ""),
        "close": s.get("close"), "score": s.get("score"), "rs": s.get("rs"),
        "entry": s.get("entry"), "stop": s.get("stop"), "risk": s.get("risk"),
        "breakout": s.get("breakout"), "fscore": f.get("fscore"), "cscore": f.get("cscore"),
        "tags": f.get("tags", []) + (["主流族群"] if s.get("ind_hot") else []),
    }


def build(d: dict) -> dict:
    mkt = d.get("market", {})
    mkt_ok = bool(mkt.get("above50") and mkt.get("above200"))
    stocks = d.get("stocks", [])
    signals = [s for s in stocks if s.get("breakout") and s.get("score", 0) >= MIN_SCORE and s.get("risk_ok")] if mkt_ok else []
    signals.sort(key=lambda s: (s.get("prefer", False), fund_total(s), s.get("rs", 0)), reverse=True)
    sig_ids = {s["id"] for s in signals}
    ready = [s for s in stocks if s.get("action") == "ready"]
    ready.sort(key=lambda s: (s.get("prefer", False), fund_total(s), s.get("rs", 0)), reverse=True)
    ready_ids = {s["id"] for s in ready[:6]}
    watch = [s for s in stocks if s.get("new") and s.get("score", 0) >= MIN_SCORE and s["id"] not in sig_ids and s["id"] not in ready_ids]
    watch.sort(key=lambda s: (s.get("score", 0), fund_total(s), s.get("rs", 0)), reverse=True)
    hot = [x for x in d.get("industries", []) if x.get("hot")]
    return {
        "date": d.get("date"), "site": SITE, "mkt_ok": mkt_ok,
        "mkt": {"close": mkt.get("close"), "above50": mkt.get("above50"), "above200": mkt.get("above200")},
        "total": len(stocks), "signals": [brief(s) for s in signals[:8]],
        "ready": [brief(s) for s in ready[:6]],
        "watch": [brief(s) for s in watch[:5]],
        "hot": [{"industry": x["industry"], "avg_rs": x["avg_rs"], "n_pass": x["n_pass"]} for x in hot],
        "auto_report": [s["id"] for s in signals[:AUTO_REPORT_MAX]],
    }


def main() -> int:
    url, key = os.getenv("GAS_URL", "").strip(), os.getenv("GAS_KEY", "").strip()
    if not url or not key:
        print("沒有設定 GAS_URL / GAS_KEY，跳過 LINE 推播")
        return 0
    d = json.loads((ROOT / "docs" / "data" / "latest.json").read_text(encoding="utf-8"))
    payload = build(d)
    try:
        payload["holdings"] = check_holdings(url, key, d)
        print(f"持股檢查：{len(payload['holdings'])} 檔")
    except Exception as e:  # noqa: BLE001
        print("⚠️ 持股檢查失敗：", type(e).__name__)
    try:
        r = requests.post(url, params={"action": "screener", "key": key},
                          data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                          headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=60)
        print("Apps Script 回應：", r.status_code, r.text[:300])
    except Exception as e:  # noqa: BLE001
        print("⚠️ 推播失敗：", e)
    return 0


# ---------------------------------------------------------------- 持股檢查（賣出規則 A）
def _prices(code: str):
    import yfinance as yf
    for suf in (".TW", ".TWO"):
        try:
            df = yf.download(code + suf, period="1y", interval="1d", auto_adjust=False, progress=False, threads=False)
        except Exception:  # noqa: BLE001
            df = None
        if df is not None and len(df) > 20:
            if hasattr(df.columns, "levels"):
                df.columns = df.columns.get_level_values(0)
            return df.dropna(subset=["Close"])
    return None


def evaluate_holding(df, buy_date: str, entry: float, stop: float, be_done: bool = False) -> dict:
    """依賣出規則 A 從買進隔天開始重播：碰停損→賣；最高價到 買價+2R→停損移到成本；保本後收盤跌破 50 日線→隔天開盤賣"""
    import pandas as pd
    c = df["Close"].astype(float)
    ma50 = c.rolling(50).mean()
    risk = entry - stop if entry > stop > 0 else entry * 0.08
    cur_stop, be = stop, be_done
    if be:
        cur_stop = max(cur_stop, entry)
    after = df[df.index > pd.Timestamp(buy_date)]
    status, note = "hold", ""
    for t, row in after.iterrows():
        if float(row["Low"]) <= cur_stop:
            status = "stop_hit"
            note = f"{t.date().isoformat()} 最低價 {float(row['Low']):.2f} 已碰到停損 {cur_stop:.2f}"
            break
        if not be and float(row["High"]) >= entry + 2 * risk:
            be, cur_stop = True, max(cur_stop, entry)
        m = ma50.loc[t]
        if be and m == m and float(row["Close"]) < m:
            status = "sell_next_open"
            note = f"{t.date().isoformat()} 收盤 {float(row['Close']):.2f} 跌破 50 日線 {m:.2f}"
            break
    last = float(c.iloc[-1])
    return {
        "status": status, "note": note, "close": round(last, 2), "date": c.index[-1].date().isoformat(),
        "stop": round(cur_stop, 2), "be": be, "be_price": round(entry + 2 * risk, 2),
        "pct": round((last / entry - 1) * 100, 2), "r": round((last - entry) / risk, 2),
        "to_stop": round((last / cur_stop - 1) * 100, 1) if cur_stop else None,
        "ma50": None if ma50.iloc[-1] != ma50.iloc[-1] else round(float(ma50.iloc[-1]), 2),
    }


def check_holdings(url: str, key: str, latest: dict) -> list:
    r = requests.get(url, params={"action": "holdings", "key": key}, timeout=60)
    items = (r.json() or {}).get("holdings", [])
    by_id = {s["id"]: s for s in latest.get("stocks", [])}
    out = []
    for h in items:
        res = {"row": h.get("row"), "code": h.get("code")}
        try:
            df = _prices(str(h["code"]))
            if df is None:
                res["error"] = "抓不到股價"
            else:
                res.update(evaluate_holding(df, str(h["buyDate"])[:10], float(h["price"]), float(h["stop"] or 0), bool(h.get("be"))))
                s = by_id.get(str(h["code"]))
                res["listed"] = bool(s)
                res["warn"] = (s or {}).get("warn", [])
        except Exception as e:  # noqa: BLE001
            res["error"] = type(e).__name__
        out.append(res)
    return out


if __name__ == "__main__":
    sys.exit(main())
