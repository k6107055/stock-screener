import requests, json
UA={'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1','Referer':'https://tw.stock.yahoo.com/'}
out={}
yr='https://tw.stock.yahoo.com/_td-stock/api/resource/'
def g(n,u,h=UA,k=1500):
    try:
        r=requests.get(u,headers=h,timeout=25); out[n]={'u':u,'code':r.status_code,'len':len(r.text),'head':r.text[:k]}
    except Exception as e: out[n]={'u':u,'err':str(e)}
for i,q in enumerate(['symbols=%5B%22%5ETWOII%22%5D;type=tick','period=1m;symbols=%5B%22%5ETWOII%22%5D','period=tick;symbols=%5B%22%5ETWOII%22%5D','period=5m;symbols=%5B%22%5ETWOII%22%5D','symbols=%5B%22%5ETWOII%22%5D','period=1d;symbols=%5B%222330.TW%22%5D;type=tick','symbols=%5B%222330.TW%22%5D;type=tick']):
    g('v%d'%i, yr+'FinanceChartService.ApacLibraCharts;'+q, k=900)
g('fm_tpex','https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=TPEx&start_date=2026-11-05',{'User-Agent':'x'},600)
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
