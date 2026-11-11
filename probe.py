import requests, json
T={'User-Agent':'Mozilla/5.0','Referer':'https://mis.taifex.com.tw/futures/','Origin':'https://mis.taifex.com.tw','Content-Type':'application/json'}
out={}
for sid in ['TXFK6-F','TXFK6-M','TXF-S']:
    r=requests.post('https://mis.taifex.com.tw/futures/api/getChartData1M',json={"SymbolID":sid},headers=T,timeout=25)
    out[sid]=r.json()
r=requests.post('https://mis.taifex.com.tw/futures/api/getQuoteList',json={"MarketType":"0","SymbolType":"F","KindID":"1","CID":"TXF","ExpireMonth":"","RowSize":"全部","PageNo":"","SortColumn":"","AscDesc":"A"},headers=T,timeout=25)
out['ql']=r.json()
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
