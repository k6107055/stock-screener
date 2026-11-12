import requests, json
out={}
B='https://api.finmindtrade.com/api/v4/data'
for ds in ['TaiwanStockFinancialStatements','TaiwanStockBalanceSheet','TaiwanStockCashFlowsStatement','TaiwanStockMonthRevenue']:
    r=requests.get(B,params={'dataset':ds,'data_id':'2059','start_date':'2025-01-01'},timeout=60)
    j=r.json(); d=j.get('data',[])
    types={}
    for x in d:
        t=x.get('type') or ''
        types.setdefault(t,[]).append((x['date'],x.get('value'),x.get('origin_name')))
    out[ds]={'msg':j.get('msg'),'n':len(d),'sample':d[:2],'types':{k:v[-3:] for k,v in types.items()}}
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
