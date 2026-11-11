import requests, json, time, re, sys
UA={'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'}
out={}
def g(name,url,method='GET',body=None,hdr=None,n=1500):
    h=dict(UA); h.update(hdr or {})
    try:
        r=requests.request(method,url,json=body,headers=h,timeout=25)
        out[name]={'url':url,'code':r.status_code,'len':len(r.text),'head':r.text[:n]}
    except Exception as e: out[name]={'url':url,'err':str(e)}
yr='https://tw.stock.yahoo.com/_td-stock/api/resource/'
R={'Referer':'https://tw.stock.yahoo.com/'}
g('ytw_chart_1d',yr+'FinanceChartService.ApacCharts;period=1d;symbols=%5B%22WTX%26%22%5D',hdr=R,n=3000)
g('ytw_chart_1d_tick',yr+'FinanceChartService.ApacCharts;period=1d;symbols=%5B%22WTX%26%22%5D;type=tick',hdr=R)
g('ytw_chart_d',yr+'FinanceChartService.ApacCharts;period=d;symbols=%5B%22WTX%26%22%5D',hdr=R)
g('ytw_chart_twii_1d',yr+'FinanceChartService.ApacCharts;period=1d;symbols=%5B%22%5ETWII%22%5D',hdr=R)
g('ytw_list_wtx',yr+'StockServices.stockList;fields=avgPrice%2Corderbook;symbols=WTX%26%2CWTXP%26',hdr=R,n=3000)
g('yahoo_twoii_1m','https://query1.finance.yahoo.com/v8/finance/chart/%5ETWOII?range=1d&interval=1m',n=600)
g('yahoo_twii_d','https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=2y&interval=1d',n=600)
g('yahoo_twoii_d','https://query1.finance.yahoo.com/v8/finance/chart/%5ETWOII?range=2y&interval=1d',n=600)
T={'Referer':'https://mis.taifex.com.tw/futures/','Origin':'https://mis.taifex.com.tw','Content-Type':'application/json'}
g('taifex_quote','https://mis.taifex.com.tw/futures/api/getQuoteList','POST',{"MarketType":"0","SymbolType":"F","KindID":"1","CID":"TXF","ExpireMonth":"","RowSize":"全部","PageNo":"","SortColumn":"","AscDesc":"A"},T,3000)
g('taifex_quote_night','https://mis.taifex.com.tw/futures/api/getQuoteList','POST',{"MarketType":"1","SymbolType":"F","KindID":"1","CID":"TXF","ExpireMonth":"","RowSize":"全部","PageNo":"","SortColumn":"","AscDesc":"A"},T,3000)
for nm in ['getChartData1M','getChartData','getTickData']:
    for sid in ['TXFL6-F','TXF-S','TXFL6-M']:
        g('taifex_%s_%s'%(nm,sid),'https://mis.taifex.com.tw/futures/api/'+nm,'POST',{"SymbolID":sid},T,800)
g('fm_fut','https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesDaily&data_id=TX&start_date=2026-11-05',n=2500)
g('fm_taiex','https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=TAIEX&start_date=2026-11-05',n=800)
g('twse_swagger','https://openapi.twse.com.tw/v1/swagger.json',n=0)
g('tpex_swagger','https://www.tpex.org.tw/openapi/swagger.json',n=0)
paths={}
for k in ['twse_swagger','tpex_swagger']:
    try:
        r=requests.get(out[k]['url'],headers=UA,timeout=30); j=r.json()
        paths[k]={p:(v.get('get') or {}).get('summary','') for p,v in j.get('paths',{}).items()}
    except Exception as e: paths[k]=str(e)
json.dump(paths,open('out/paths.json','w'),ensure_ascii=False,indent=1)
kw=re.compile('重大|公告|內部人|董監|轉讓|設質|質權|持股|異動|申報')
cand=[]
for k,ps in paths.items():
    if isinstance(ps,dict):
        for p,s in ps.items():
            if kw.search(s): cand.append((k,p,s))
base={'twse_swagger':'https://openapi.twse.com.tw/v1','tpex_swagger':'https://www.tpex.org.tw/openapi/v1'}
for k,p,s in cand[:60]:
    g('api '+s+' '+p, base[k]+p, n=700)
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
