"""
每日選股跑完後，把結果交給 LINE 小幫手（Google Apps Script）：
- 推播今日買進訊號、新上榜高分股、主流族群給所有成員
- 買進訊號最多 3 檔自動排入「整合報告」流程

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
    signals.sort(key=lambda s: (fund_total(s), s.get("rs", 0)), reverse=True)
    sig_ids = {s["id"] for s in signals}
    watch = [s for s in stocks if s.get("new") and s.get("score", 0) >= MIN_SCORE and s["id"] not in sig_ids]
    watch.sort(key=lambda s: (s.get("score", 0), fund_total(s), s.get("rs", 0)), reverse=True)
    hot = [x for x in d.get("industries", []) if x.get("hot")]
    return {
        "date": d.get("date"), "site": SITE, "mkt_ok": mkt_ok,
        "mkt": {"close": mkt.get("close"), "above50": mkt.get("above50"), "above200": mkt.get("above200")},
        "total": len(stocks), "signals": [brief(s) for s in signals[:8]],
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
        r = requests.post(url, params={"action": "screener", "key": key},
                          data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                          headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=60)
        print("Apps Script 回應：", r.status_code, r.text[:300])
    except Exception as e:  # noqa: BLE001
        print("⚠️ 推播失敗：", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
