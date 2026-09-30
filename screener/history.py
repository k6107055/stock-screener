"""
個股上榜歷史（仿「搜尋股票」看每天有沒有上榜）

docs/data/hist/
  _calendar.json   所有交易日（算「連續上榜幾天」用）
  _index.json      曾經上榜過的股票清單 [[代號, 名稱, 產業, 最後上榜日, 上榜天數], ...]
  <代號>.json      {"id","name","industry","ex","rows":[[日期, 標記, 評分, 20日漲幅%, RS, 收盤], ...]}
                   標記：1 = 創一年新高（當天最高價＝252 日最高）、2 = 今日突破（可相加）

- 歷史回測（每週六）整批重建近一年
- 每日選股跑完後，把當天上榜的股票補進去
"""
from __future__ import annotations

import json
from pathlib import Path

NEWHIGH, BREAKOUT = 1, 2
KEEP_DAYS = 250          # 上榜紀錄保留約一年（250 個交易日）


def _dump(p: Path, obj) -> None:
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def _r(x, nd=1):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if x != x else round(x, nd)


def write_index(hdir: Path) -> None:
    idx = []
    for p in sorted(hdir.glob("[0-9]*.json")):
        d = _load(p, None)
        if not d or not d.get("rows"):
            continue
        idx.append([d["id"], d.get("name", ""), d.get("industry", ""), d["rows"][-1][0], len(d["rows"])])
    _dump(hdir / "_index.json", idx)


# ---------------------------------------------------------------- 回測整批重建
def rebuild_from_panel(ind: dict, meta: dict, start_i: int, out_dir: Path) -> None:
    import numpy as np

    C, H = ind["C"], ind["H"]
    hi252 = H.rolling(252).max()
    ret20 = (C / C.shift(20) - 1) * 100
    trend = ind["trend"].to_numpy()
    newhigh = (H >= hi252).to_numpy()
    bo = ind["breakout"].to_numpy()
    score = ind["score"].to_numpy()
    rs = ind["rs"].to_numpy()
    r20 = ret20.to_numpy()
    cl = C.to_numpy()
    dates = [d.date().isoformat() for d in C.index]

    start_i = max(start_i, len(dates) - KEEP_DAYS)   # 只保留近一年
    hdir = out_dir / "hist"
    hdir.mkdir(parents=True, exist_ok=True)
    for f in hdir.glob("*.json"):
        f.unlink()
    n = 0
    for j, sid in enumerate(C.columns):
        rows_i = np.flatnonzero(trend[start_i:, j]) + start_i
        if not len(rows_i):
            continue
        rows = []
        for i in rows_i:
            flag = (NEWHIGH if newhigh[i, j] else 0) | (BREAKOUT if bo[i, j] else 0)
            rows.append([dates[i], flag, int(score[i, j]), _r(r20[i, j]), None if rs[i, j] != rs[i, j] else int(rs[i, j]), _r(cl[i, j], 2)])
        m = meta.get(sid, {})
        _dump(hdir / f"{sid}.json", {"id": sid, "name": m.get("name", ""), "industry": m.get("industry", ""),
                                     "ex": m.get("ex", "TWSE"), "rows": rows})
        n += 1
    _dump(hdir / "_calendar.json", dates[start_i:])
    write_index(hdir)
    print(f"上榜歷史：重建 {n} 檔（{dates[start_i]}～{dates[-1]}）", flush=True)


# ---------------------------------------------------------------- 連續上榜天數
def streaks(ids: list[str], day: str, out_dir: Path) -> dict[str, int]:
    """今天（day）也在榜上的前提下，連續上榜幾個交易日（含今天）"""
    hdir = out_dir / "hist"
    cal = _load(hdir / "_calendar.json", [])
    cal = [d for d in cal if d < day]
    out = {}
    for sid in ids:
        rows = _load(hdir / f"{sid}.json", {}).get("rows", [])
        have = {r[0] for r in rows}
        n = 1
        for d in reversed(cal):
            if d in have:
                n += 1
            else:
                break
        out[sid] = n
    return out


# ---------------------------------------------------------------- 每日補當天
def append_daily(result: dict, out_dir: Path) -> None:
    hdir = out_dir / "hist"
    hdir.mkdir(parents=True, exist_ok=True)
    day = result["date"]
    cal = _load(hdir / "_calendar.json", [])
    if not cal or cal[-1] < day:
        cal.append(day)
        _dump(hdir / "_calendar.json", cal)
    for s in result.get("stocks", []):
        p = hdir / f"{s['id']}.json"
        d = _load(p, None) or {"id": s["id"], "rows": []}
        d.update(name=s.get("name", ""), industry=s.get("industry", ""), ex=s.get("ex", "TWSE"))
        d["rows"] = [r for r in d["rows"] if r[0] != day]          # 同一天重跑就覆蓋
        flag = (NEWHIGH if s.get("newhigh") else 0) | (BREAKOUT if s.get("breakout") else 0)
        d["rows"].append([day, flag, s.get("score", 0), s.get("ret20"), s.get("rs"), s.get("close")])
        d["rows"].sort(key=lambda r: r[0])
        _dump(p, d)
    write_index(hdir)
