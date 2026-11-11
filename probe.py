import requests, json, os, time
K=os.environ.get('GEMINI_API_KEY','')
H={'Content-Type':'application/json','x-goog-api-key':K}
out={'haskey':bool(K)}
B='https://generativelanguage.googleapis.com/v1beta/'
try:
    r=requests.get(B+'models?pageSize=200',headers=H,timeout=30)
    out['models']=[m['name'] for m in r.json().get('models',[]) if 'flash' in m['name']]
except Exception as e: out['models']=str(e)
def t(name,url,body,to=120):
    t0=time.time()
    try:
        r=requests.post(url,json=body,headers=H,timeout=to); out[name]={'code':r.status_code,'sec':round(time.time()-t0,1),'head':r.text[:700]}
    except Exception as e: out[name]={'err':str(e)[:200],'sec':round(time.time()-t0,1)}
msg={'contents':[{'parts':[{'text':'用一句話說台積電是什麼公司，輸出 JSON {"a":"..."}'}]}]}
for m in ['gemini-3.8-flash','gemini-flash-latest','gemini-3-flash']:
    t(m+'_plain',B+f'models/{m}:generateContent',dict(msg,generationConfig={'responseMimeType':'application/json'}))
    t(m+'_low',B+f'models/{m}:generateContent',dict(msg,generationConfig={'responseMimeType':'application/json','thinkingConfig':{'thinkingLevel':'low'}}))
t('interactions',B+'interactions',{'model':'gemini-3.8-flash','input':'用一句話說台積電是什麼公司'})
json.dump(out,open('out/probe.json','w'),ensure_ascii=False,indent=1)
