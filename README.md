# SEPA 選股系統

依《超級績效》（Minervini SEPA / VCP）每天自動篩選台股上市櫃股票，網站顯示：

- **趨勢模板 8 條**全過才上榜
- **4 條型態規則評分**：① 不追高 ② 近突破點 ③ 波動收斂 ④ 量縮
- **今日突破**訊號（帶量突破樞紐點）
- 建議買點、停損、風險%，以及依「每筆最多虧 1%」算出的可買股數
- 滑過股票看 TradingView K 線（手機點一下）、同產業上榜數、新上榜標記

## 檔案

| 位置 | 內容 |
|---|---|
| `screener/screener.py` | 篩選程式，所有門檻在檔案上方 `P = {...}` |
| `docs/index.html` | 網站（優分析網址設定在 `UANALYZE_URL`） |
| `docs/data/` | 每日結果（自動產生） |
| `.github/workflows/daily.yml` | 每個交易日 19:17 自動執行 |

## 第一次設定

1. **開啟網站**：Settings → Pages → Source 選「Deploy from a branch」，Branch 選 `main`、資料夾選 `/docs`，按 Save
2. **先手動跑一次**：Actions → 左邊「每日選股」→ Run workflow
3. （選用）**FinMind token**：Settings → Secrets and variables → Actions → New repository secret，名稱 `FINMIND_TOKEN`

網站網址：`https://k6107055.github.io/stock-screener/`

## 資料來源

股票清單：FinMind（備援：證交所、櫃買中心 OpenAPI）；股價：Yahoo Finance（yfinance，還原權息）。

本系統只是篩選工具，不構成投資建議。
