import os, re, json, time, requests
K = os.getenv('GEMINI_API_KEY', '')
UA = {'User-Agent': 'Mozilla/5.0'}
out = {}
def save():
    json.dump(out, open('out/r.json', 'w'), ensure_ascii=False, indent=1)
# 1 MOPS RSS link
try:
    r = requests.get('https://mopsov.twse.com.tw/nas/rss/mopsrss201001.xml', headers=UA, timeout=40)
    t = r.content.decode('cp950', 'replace')
    its = t.split('<item>')[1:4]
    out['rss'] = []
    for it in its:
        link = (re.search(r'<link>\s*<!\[CDATA\[(.*?)\]\]>', it, re.S) or [None, ''])[1]
        desc = (re.search(r'<description>\s*<!\[CDATA\[(.*?)\]\]>', it, re.S) or [None, ''])[1]
        o = {'link': link, 'desc': desc[:200]}
        try:
            g = requests.get(link.replace('http://', 'https://'), headers=UA, timeout=40)
            txt = g.content.decode('utf-8', 'replace')
            o['st'] = g.status_code; o['len'] = len(txt)
            plain = re.sub(r'<[^>]+>', ' ', txt); plain = re.sub(r'\s+', ' ', plain)
            o['plain'] = plain[:1500]
        except Exception as e:
            o['err'] = str(e)
        out['rss'].append(o)
except Exception as e:
    out['rsserr'] = str(e)
save()
# 2 podcasts
out['pod'] = {}
for q in ['股癌', '兆華與股惑仔', '財經皓角', '游庭皓', 'KY99', '優分析', '統一投顧']:
    try:
        r = requests.get('https://itunes.apple.com/search', params={'term': q, 'media': 'podcast', 'country': 'TW', 'limit': 5}, timeout=30).json()
        out['pod'][q] = [{'n': x.get('collectionName'), 'a': x.get('artistName'), 'feed': x.get('feedUrl'), 'id': x.get('collectionId')} for x in r.get('results', [])]
    except Exception as e:
        out['pod'][q] = str(e)
save()
feeds = {}
for q, lst in out['pod'].items():
    if isinstance(lst, list):
        for x in lst[:2]:
            if x.get('feed'): feeds[x['n']] = x['feed']
out['feeds'] = {}
for n, f in feeds.items():
    try:
        t = requests.get(f, headers=UA, timeout=40).text
        it = t.split('<item')[1:3]
        o = []
        for i in it:
            o.append({'title': (re.search(r'<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>', i, re.S) or [None, ''])[1][:120],
                      'enc': (re.search(r'<enclosure[^>]*url="([^"]+)"[^>]*', i) or [None, ''])[0][:300],
                      'dur': (re.search(r'<itunes:duration>(.*?)</itunes:duration>', i) or [None, ''])[1],
                      'date': (re.search(r'<pubDate>(.*?)</pubDate>', i) or [None, ''])[1],
                      'desclen': len(i)})
        out['feeds'][n] = o
    except Exception as e:
        out['feeds'][n] = str(e)
save()
# 3 Gemini: models + audio countTokens + youtube countTokens
H = {'x-goog-api-key': K}
try:
    ms = requests.get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', headers=H, timeout=30).json()
    out['models'] = [m['name'] for m in ms.get('models', []) if 'flash' in m['name']]
except Exception as e:
    out['models'] = str(e)
save()
# download first gooaye enclosure and upload
try:
    enc = None
    for n, o in out['feeds'].items():
        if '股癌' in n and isinstance(o, list) and o:
            enc = re.search(r'url="([^"]+)"', o[0]['enc']).group(1); break
    out['enc'] = enc
    if enc:
        t0 = time.time(); a = requests.get(enc, headers=UA, timeout=300).content
        out['dl'] = {'bytes': len(a), 'sec': round(time.time() - t0, 1)}
        st = requests.post('https://generativelanguage.googleapis.com/upload/v1beta/files', headers={**H, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': str(len(a)), 'X-Goog-Upload-Header-Content-Type': 'audio/mpeg', 'Content-Type': 'application/json'}, json={'file': {'display_name': 'p'}}, timeout=60)
        up = st.headers.get('x-goog-upload-url')
        f = requests.post(up, headers={'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Length': str(len(a))}, data=a, timeout=300).json()
        out['file'] = f
        uri = f['file']['uri']
        for _ in range(30):
            s = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{f['file']['name']}", headers=H, timeout=30).json()
            if s.get('state') == 'ACTIVE': break
            time.sleep(5)
        out['fstate'] = s.get('state')
        ct = requests.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:countTokens', headers=H, json={'contents': [{'parts': [{'file_data': {'mime_type': 'audio/mpeg', 'file_uri': uri}}]}]}, timeout=60)
        out['audiotok'] = ct.text[:500]
        # try a short transcription of first 3 minutes
        t0 = time.time()
        g = requests.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent', headers=H, json={'contents': [{'parts': [{'file_data': {'mime_type': 'audio/mpeg', 'file_uri': uri}}, {'text': '只把 00:00 到 03:00 的內容逐字轉成繁體中文逐字稿，每 30 秒標一次時間 [mm:ss]。'}]}], 'generationConfig': {'temperature': 0.2}}, timeout=300)
        out['tr'] = {'st': g.status_code, 'sec': round(time.time() - t0, 1), 'txt': g.text[:2500]}
except Exception as e:
    out['audioerr'] = repr(e)
save()
try:
    ct = requests.post('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:countTokens', headers=H, json={'contents': [{'parts': [{'file_data': {'file_uri': 'https://www.youtube.com/watch?v=jNQXAC9IVRw'}}]}], 'generationConfig': {'mediaResolution': 'MEDIA_RESOLUTION_LOW'}}, timeout=60)
    out['yttok'] = ct.text[:400]
except Exception as e:
    out['yterr'] = repr(e)
save()
