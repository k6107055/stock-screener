import requests, json
UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'}
out={}
def t(n,method,u,**kw):
    try:
        r=requests.request(method,u,headers=dict(UA,**kw.pop('h',{})),timeout=30,**kw)
        out[n]={'code':r.status_code,'len':len(r.text),'ct':r.headers.get('content-type'),'head':r.text[:1500]}
    except Exception as e: out[n]={'err':str(e)}
t('ov_ajax','POST','https://mopsov.twse.com.tw/mops/web/ajax_t05sr01_1',data={'encodeURIComponent':'1','step':'0','firstin':'true','off':'1','TYPEK':'all'})
t('ov_page','GET','https://mopsov.twse.com.tw/mops/web/t05sr01_1')
t('new_api','POST','https://mops.twse.com.tw/mops/api/t05sr01_1',json={'count':'0','marketKind':''},h={'Content-Type':'application/json','Referer':'https://mops.twse.com.tw/mops/#/web/t05sr01_1'})
t('new_api2','POST','https://mops.twse.com.tw/mops/api/home_page/t05sr01_1',json={'count':'0','marketKind':''},h={'Content-Type':'application/json'})
t('new_page','GET','https://mops.twse.com.tw/mops/#/web/t05sr01_1')
t('rss','GET','https://mopsov.twse.com.tw/nas/rss/mopsrss201001.xml')
t('rss2','GET','https://mops.twse.com.tw/nas/rss/mopsrss201001.xml')
t('twse_news','GET','https://www.twse.com.tw/rwd/zh/announcement/announcement?response=json')
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
r=requests.get('https://mopsov.twse.com.tw/nas/rss/mopsrss201001.xml',headers=UA,timeout=30)
open('out/rss.xml','wb').write(r.content)
