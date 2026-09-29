# SEPA 選股系統

依《超級績效》（Minervini SEPA / VCP）每天自動篩選台股上市櫃股票，網站顯示：

- **趨勢模板 8 條**全過才上榜
- **4 條型態規則評分**：① 不追高 ② 近突破點 ③ 波動收斂 ④ 量縮
- **今日突破**訊號（帶量突破樞紐點）
- 建議買點、停損、風險%，以及依「每筆最多虧 1%」算出的可買股數
- 滑過股票看 K 線（手機點一下），視窗內可切換「營收」「獲利」圖
- **書中基本面分**（0～3）：季 EPS 年增 ≥ 25%、EPS 加速、營收年增 ≥ 20% 且利潤率擴張
- **循環分**（0～3）：月營收加速、毛利率翻揚、營收創 24 個月新高；**擴產中／循環後段**標籤
- **產業族群強度**：各產業平均 RS 與過關檔數，🔥 標出主流族群
- **報告按鈕**：打開 LINE 送出「報告 代號」，由 LINE 小幫手產生整合報告
- 每天跑完推播 LINE（買進訊號、新上榜高分股、主流族群），買進訊號最多 3 檔自動產生整合報告

## 檔案

| 位置 | 內容 |
|---|---|
| `screener/screener.py` | 篩選程式，所有門檻在檔案上方 `P = {...}` |
| `screener/fundamentals.py` | 基本面（FinMind 月營收、季報、現金流），門檻在 `FP = {...}`，快取在 `docs/data/fund/` |
| `screener/notify.py` | 跑完後交給 LINE 小幫手（Apps Script）推播與自動報告 |
| `docs/index.html` | 網站（優分析網址設定在 `UANALYZE_URL`） |
| `docs/data/` | 每日結果（自動產生） |
| `.github/workflows/daily.yml` | 每個交易日 19:17 自動執行 |

## 第一次設定

1. **開啟網站**：Settings → Pages → Source 選「Deploy from a branch」，Branch 選 `main`、資料夾選 `/docs`，按 Save
2. **先手動跑一次**：Actions → 左邊「每日選股」→ Run workflow
3. **FinMind token**（基本面需要）：Settings → Secrets and variables → Actions → New repository secret，名稱 `FINMIND_TOKEN`
4. **LINE 推播**：同一個地方再新增 `GAS_URL`（Apps Script 網址，結尾 /exec）與 `GAS_KEY`（跟竄改猴同一串 KEY）

網站網址：`https://k6107055.github.io/stock-screener/`

## 資料來源

股票清單：FinMind（備援：證交所、櫃買中心 OpenAPI）；股價：Yahoo Finance（yfinance，還原權息）。

本系統只是篩選工具，不構成投資建議。
