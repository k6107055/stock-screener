"""
Atlas 影音解析（Podcast＋YouTube → Gemini 完整解析 → 循環帳本）
  ・訂閱清單在 media/sources.json：auto＝新集數自動解析；btn＝放進清單，按「📝 解析」才做
  ・兩段式省額度：① 便宜的 Flash-Lite 聽音檔／看影片 → 逐字稿（含時間）② 比較聰明的 Flash 讀逐字稿 → 重點、個股、循環判斷
  ・循環帳本 cycle.json：每次判斷都記下來，下一集進來就比對「階段有沒有變、不同節目有沒有打架」
  ・這裡只放公開內容（節目內容、產業判斷）；跟你持股有關的對照在 Atlas／Apps Script 做（不放到公開的 GitHub）
輸出（發佈到 media-data 分支，Atlas 直接讀）：index.json、n/<id>.json、cycle.json、state.json
環境變數：GEMINI_API_KEY、MEDIA_REQ（要解析的 id 或網址，逗號／空白分隔）、MAX_AUTO（這次最多自動解析幾集）
"""
import os, re, sys, json, time, hashlib, html as H
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

TW = timezone(timedelta(hours=8))
OUT = sys.argv[1] if len(sys.argv) > 1 else 'media-out'
KEY = os.getenv('GEMINI_API_KEY', '')
REQ = [x for x in re.split(r'[\s,]+', os.getenv('MEDIA_REQ', '')) if x]
MAX_AUTO = int(os.getenv('MAX_AUTO', '4') or 4)
T0 = time.time()
DEADLINE = T0 + 48 * 60          # GitHub 一次最多 60 分鐘，留 12 分鐘發佈
KEEP_ITEMS_DAYS = 45
KEEP_NOTE_DAYS = 120
KEEP_CYCLE_DAYS = 400
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'}
G = 'https://generativelanguage.googleapis.com'
LOG, ERRS = [], []

STAGES = ['未知', '訂單回升', '稼動率滿載', '缺貨漲價', '宣布擴產', '新產能量產', '同業產能開出']
INDS = ['AI伺服器', '先進封裝/CoWoS', '晶圓代工', '記憶體', 'IC設計', '半導體設備', 'ABF載板', 'PCB/CCL', '散熱', '電源',
        '光通訊/矽光子', '網通', '被動元件', '矽晶圓', '面板', '重電/電網', '機器人', '低軌衛星', '電動車/汽車', '手機/消費電子',
        '航運', '鋼鐵/原物料', '塑化', '金融', '生技醫療', '營建', '消費/零售', '軍工', '總經/利率', '匯率', '美股科技巨頭', '原油/能源', '其他']


def now():
    return datetime.now(TW)


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s[:300])


def jload(p, d):
    try:
        return json.load(open(os.path.join(OUT, p), encoding='utf-8'))
    except Exception:
        return d


def jsave(p, o):
    fp = os.path.join(OUT, p)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(o, f, ensure_ascii=False, separators=(',', ':'))


# ============ 抓新集數 ============
def txt(el, path, ns=None):
    x = el.find(path, ns) if ns else el.find(path)
    return (x.text or '').strip() if x is not None and x.text else ''


def parse_dur(s):
    s = (s or '').strip()
    if not s:
        return 0
    if s.isdigit():
        return int(s)
    p = [int(x) for x in s.split(':') if x.isdigit()]
    t = 0
    for x in p:
        t = t * 60 + x
    return t


def iso(dt):
    return dt.astimezone(TW).strftime('%Y-%m-%dT%H:%M')


def pod_items(src):
    out = []
    try:
        r = requests.get(src['feed'], headers=UA, timeout=40)
        root = ET.fromstring(r.content)
        IT = '{http://www.itunes.com/dtds/podcast-1.0.dtd}'
        for it in root.iter('item'):
            enc = it.find('enclosure')
            if enc is None:
                continue
            url = enc.attrib.get('url', '')
            guid = txt(it, 'guid') or url
            try:
                from email.utils import parsedate_to_datetime
                pub = parsedate_to_datetime(txt(it, 'pubDate'))
            except Exception:
                continue
            out.append({'id': 'pod-' + hashlib.sha1(guid.encode()).hexdigest()[:12], 'src': 'pod', 'ch': src['name'], 'tier': src['tier'],
                        'title': txt(it, 'title'), 'url': txt(it, 'link') or url, 'audio': url, 'pub': iso(pub),
                        'dur': parse_dur(txt(it, IT + 'duration')), 'desc': re.sub(r'<[^>]+>', ' ', txt(it, 'description'))[:1500]})
            if len(out) >= 8:
                break
    except Exception as e:
        ERRS.append(f"{src['name']} RSS：{e}")
    return out


NS = {'atom': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015', 'media': 'http://search.yahoo.com/mrss/'}


def yt_items(src):
    out = []
    try:
        r = requests.get('https://www.youtube.com/feeds/videos.xml?channel_id=' + src['id'], headers=UA, timeout=30)
        root = ET.fromstring(r.content)
        for e in root.findall('atom:entry', NS):
            vid = txt(e, 'yt:videoId', NS)
            title = txt(e, 'atom:title', NS)
            link = (e.find('atom:link', NS).attrib.get('href') if e.find('atom:link', NS) is not None else '') or ''
            if not vid or '#short' in title.lower() or '/shorts/' in link:
                continue
            g = e.find('media:group', NS)
            desc = txt(g, 'media:description', NS) if g is not None else ''
            pub = datetime.fromisoformat(txt(e, 'atom:published', NS).replace('Z', '+00:00'))
            out.append({'id': 'yt-' + vid, 'src': 'yt', 'ch': src['name'], 'tier': src['tier'], 'title': title,
                        'url': 'https://www.youtube.com/watch?v=' + vid, 'vid': vid, 'pub': iso(pub), 'dur': 0, 'desc': desc[:1500]})
            if len(out) >= 6:
                break
    except Exception as e:
        ERRS.append(f"{src['name']} RSS：{e}")
    return out


def resolve_req(u):
    """Telegram 傳來的網址 → 一筆待解析項目"""
    m = re.search(r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|live/|shorts/)|youtu\.be/)([\w-]{11})', u)
    if m:
        vid = m.group(1)
        it = {'id': 'yt-' + vid, 'src': 'yt', 'ch': '手動', 'tier': 'btn', 'title': u, 'url': 'https://www.youtube.com/watch?v=' + vid, 'vid': vid,
              'pub': iso(now()), 'dur': 0, 'desc': ''}
        try:
            j = requests.get('https://www.youtube.com/oembed', params={'url': it['url'], 'format': 'json'}, timeout=20).json()
            it['title'] = j.get('title') or u
            it['ch'] = j.get('author_name') or '手動'
        except Exception:
            pass
        return it
    m = re.search(r'podcasts\.apple\.com/.*/id(\d+)', u)
    if m:
        ep = (re.search(r'[?&]i=(\d+)', u) or [None, None])[1]
        try:
            j = requests.get('https://itunes.apple.com/lookup', params={'id': m.group(1), 'entity': 'podcastEpisode', 'limit': 300, 'country': 'TW'}, timeout=30).json()
            eps = [x for x in j.get('results', []) if x.get('wrapperType') == 'podcastEpisode']
            x = next((x for x in eps if ep and str(x.get('trackId')) == ep), eps[0] if eps else None)
            if x:
                au = x.get('episodeUrl') or ''
                return {'id': 'pod-' + hashlib.sha1((x.get('episodeGuid') or au).encode()).hexdigest()[:12], 'src': 'pod', 'ch': x.get('collectionName', '手動'),
                        'tier': 'btn', 'title': x.get('trackName', u), 'url': u, 'audio': au, 'pub': (x.get('releaseDate') or iso(now()))[:16],
                        'dur': int((x.get('trackTimeMillis') or 0) / 1000), 'desc': (x.get('description') or '')[:1500]}
        except Exception as e:
            ERRS.append(f'Apple Podcasts 連結：{e}')
        return None
    if re.search(r'\.(mp3|m4a|aac|wav)(\?|$)', u, re.I):
        return {'id': 'pod-' + hashlib.sha1(u.encode()).hexdigest()[:12], 'src': 'pod', 'ch': '手動', 'tier': 'btn', 'title': u.split('/')[-1][:80],
                'url': u, 'audio': u, 'pub': iso(now()), 'dur': 0, 'desc': ''}
    return None


# ============ Gemini ============
MODELS = {'lite': [], 'smart': []}


def pick_models():
    names = []
    try:
        r = requests.get(G + '/v1beta/models?pageSize=300', headers={'x-goog-api-key': KEY}, timeout=30)
        for m in r.json().get('models', []):
            if 'generateContent' in m.get('supportedGenerationMethods', []):
                names.append(m['name'].split('/')[-1])
    except Exception as e:
        log('查模型失敗', e)
    lite = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-flash-lite', n)], key=lambda n: -float(re.findall(r'[\d.]+', n)[0]))
    smart = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-flash', n)], key=lambda n: -float(re.findall(r'[\d.]+', n)[0]))
    MODELS['lite'] = list(dict.fromkeys(lite + ['gemini-flash-lite-latest'] + smart[-2:]))
    MODELS['smart'] = list(dict.fromkeys(['gemini-flash-latest'] + smart + lite[:2]))
    log('逐字稿模型', MODELS['lite'][:4], '分析模型', MODELS['smart'][:4])


USED = {}


def gen(kind, parts, js=False, max_out=65536, timeout=900, extra=None):
    """依序試模型；忙線（503/500）換下一個；額度滿（429）等一下再換；回傳 (文字, 模型, 是否被截斷)"""
    think = [{'thinkingLevel': 'low'}, {'thinkingBudget': 0}, None]
    for mi, model in enumerate(MODELS[kind]):
        for attempt in range(3):
            if time.time() > DEADLINE:
                raise RuntimeError('這次執行時間用完，下次排程再做')
            gc = {'temperature': 0.2, 'maxOutputTokens': max_out}
            if js:
                gc['responseMimeType'] = 'application/json'
            if think[0]:
                gc['thinkingConfig'] = think[0]
            if extra:
                gc.update(extra)
            try:
                r = requests.post(f'{G}/v1beta/models/{model}:generateContent', headers={'x-goog-api-key': KEY},
                                  json={'contents': [{'parts': parts}], 'generationConfig': gc}, timeout=timeout)
            except Exception as e:
                ERRS.append(f'{model} {str(e)[:100]}')
                break
            if r.status_code == 200:
                j = r.json()
                c = (j.get('candidates') or [{}])[0]
                t = ''.join(p.get('text', '') for p in (c.get('content') or {}).get('parts', []) if not p.get('thought'))
                USED[model] = USED.get(model, 0) + 1
                if t.strip():
                    return t, model, c.get('finishReason') == 'MAX_TOKENS'
                ERRS.append(f'{model} 空白回應 {c.get("finishReason")}')
                break
            body = r.text[:200]
            if r.status_code == 400 and 'thinking' in body.lower() and think[0]:
                think.pop(0)
                continue
            if r.status_code == 400 and ('mediaResolution' in body or 'media_resolution' in body) and extra:
                extra = None
                continue
            ERRS.append(f'{model} {r.status_code} {body}')
            if r.status_code == 429:
                if 'PerDay' in body or 'per day' in body.lower():
                    break                      # 這個模型今天額度用完 → 換下一個
                time.sleep(45)
                continue
            if r.status_code in (500, 503, 504):
                time.sleep(8)
                if attempt >= 1:
                    break
                continue
            break                              # 404 等其他錯誤 → 換模型
    raise RuntimeError('Gemini 每個模型都失敗（可能今天額度用完）')


def upload(url):
    r = requests.get(url, headers=UA, timeout=600)
    r.raise_for_status()
    data = r.content
    mime = 'audio/mp4' if re.search(r'\.(m4a|mp4|aac)(\?|$)', url, re.I) else 'audio/mpeg'
    st = requests.post(G + '/upload/v1beta/files', headers={'x-goog-api-key': KEY, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
                       'X-Goog-Upload-Header-Content-Length': str(len(data)), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json'},
                       json={'file': {'display_name': 'atlas-media'}}, timeout=60)
    up = st.headers.get('x-goog-upload-url')
    if not up:
        raise RuntimeError('上傳音檔失敗 ' + st.text[:200])
    f = requests.post(up, headers={'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Length': str(len(data))}, data=data, timeout=600).json()['file']
    for _ in range(60):
        s = requests.get(f"{G}/v1beta/{f['name']}", headers={'x-goog-api-key': KEY}, timeout=30).json()
        if s.get('state') == 'ACTIVE':
            return f['name'], f['uri'], mime, len(data)
        if s.get('state') == 'FAILED':
            raise RuntimeError('Gemini 處理音檔失敗')
        time.sleep(5)
    raise RuntimeError('Gemini 處理音檔逾時')


def drop_file(name):
    try:
        requests.delete(f'{G}/v1beta/{name}', headers={'x-goog-api-key': KEY}, timeout=30)
    except Exception:
        pass


TR_RULE = """把內容完整逐字轉成繁體中文逐字稿。規則：
1. 每段一行，行首標時間 [mm:ss]（超過一小時用 [h:mm:ss]），時間是從節目開頭算的實際時間；大約每 20～40 秒或換話題就換一行。
2. 保留原意與所有內容，口語贅字可以刪，但不要摘要、不要省略。
3. 業配／廣告段落只寫一行：[mm:ss] （廣告）
4. 股票、公司、英文術語盡量寫對（例如 台積電、CoWoS、HBM、輝達 NVIDIA）。
只輸出逐字稿本身，不要任何說明。"""


def fmt_ts(s):
    s = int(s)
    return f'{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}' if s >= 3600 else f'{s // 60:02d}:{s % 60:02d}'


def parse_tr(t, base=0):
    out = []
    for line in t.splitlines():
        m = re.match(r'\s*\[\s*(?:(\d+):)?(\d{1,3}):(\d{2})\s*\]\s*(.*)', line)
        if not m:
            if out and line.strip():
                out[-1][1] += line.strip()
            continue
        s = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        out.append([s, m.group(4).strip()])
    if base and out and out[0][0] < base - 90:      # 模型用了「片段內」的時間 → 加回起點
        out = [[s + base, x] for s, x in out]
    return [x for x in out if x[1]]


def transcribe_audio(it):
    name, uri, mime, size = upload(it['audio'])
    try:
        part = {'file_data': {'mime_type': mime, 'file_uri': uri}}
        tr, model = [], ''
        for _ in range(4):
            ask = TR_RULE if not tr else TR_RULE + f'\n\n前面已經轉到 [{fmt_ts(tr[-1][0])}]，請從那之後接著轉到節目結尾。'
            t, model, cut = gen('lite', [part, {'text': ask}])
            more = parse_tr(t)
            if tr:
                more = [x for x in more if x[0] > tr[-1][0]]
            tr += more
            if not cut or not more:
                break
        return tr, model
    finally:
        drop_file(name)


SEG = 25 * 60


def transcribe_yt(it):
    tr, model, start = [], '', 0
    for _ in range(5):                      # 最多 5 段 × 25 分鐘
        part = {'file_data': {'file_uri': it['url']}, 'video_metadata': {'start_offset': f'{start}s', 'end_offset': f'{start + SEG}s'}}
        ask = TR_RULE + f'\n\n這次只轉影片 {fmt_ts(start)} 到 {fmt_ts(start + SEG)} 這一段（影片比較短就轉到結尾為止）。'
        t, model, cut = gen('lite', [part, {'text': ask}], extra={'mediaResolution': 'MEDIA_RESOLUTION_LOW'})
        more = [x for x in parse_tr(t, start) if not tr or x[0] > tr[-1][0]]
        tr += more
        if not more or more[-1][0] < start + SEG - 120:
            break                            # 影片結束了
        start += SEG
        time.sleep(20)                       # 免費方案每分鐘 token 有上限，分段之間喘口氣
    if tr:
        it['dur'] = max(it.get('dur') or 0, tr[-1][0] + 30)
    return tr, model


ANA = """你是嚴守紀律、重視基本面與產業供需的台股研究員。下面是一集財經節目的逐字稿（每行開頭是時間）。
請用「產業循環」框架讀這集，輸出 JSON（只輸出 JSON）。

【循環階段定義】（stage 填數字）
1 訂單回升：需求回溫、客戶拉貨、庫存去化完
2 稼動率滿載：產能利用率拉滿、交期拉長
3 缺貨漲價：供不應求、漲價、毛利率上升（超額利潤期，股價漲最快）
4 宣布擴產：公司宣布資本支出／蓋新廠
5 新產能量產：新產能開出、量增營收成長，折舊可能壓毛利
6 同業產能開出：競爭者產能也出來、價格鬆動 → 循環尾聲
0 節目沒講到足夠資訊就填 0，不要硬猜

【判讀重點】
・需求面（客戶拉貨、規格升級）推動的上修＝循環還沒到尾端；供給面（產出、市占超預期）推動的上修＝偏後段
・供應鏈受惠順序固定（例：CoWoS 擴產 → 設備 → 材料／ABF → 封裝 → 測試），要指出提到的公司在哪一棒、前一棒走到哪
・資金追超額利潤，之後回到評價：若講者說「明年 EPS 今年先反映」，要在 priced_in 提醒評價修正風險
・每個判斷標 fact：「事實」＝講者引用的數據／公司公告／報價；「推論」＝講者或你的推測
・時間 t 用逐字稿裡的 [mm:ss]

【產業名稱】盡量從這份清單選：%s

【JSON 格式】
{
 "one": "30 字內一句話結論",
 "bias": "偏多|偏空|中性",
 "tags": ["主題標籤，最多 5 個"],
 "hl": ["3～5 個重點，每點 40 字內"],
 "ch": [{"t": "mm:ss", "title": "章節名", "key": true/false, "sum": "這段在講什麼，40 字內"}],
 "stk": [{"c": "台股代號（美股寫代號如 NVDA，沒有就空字串）", "n": "公司名", "v": "偏多|偏空|中性", "why": "理由", "num": "提到的數字（目標價、EPS、營收…），沒有就空字串", "t": "mm:ss", "fact": "事實|推論"}],
 "cyc": [{"ind": "產業", "stage": 0-6, "side": "需求|供給|—", "ev": "判斷依據 50 字內", "t": "mm:ss", "fact": "事實|推論"}],
 "chain": [{"ind": "產業", "order": "受惠順序，例：設備→材料→封裝→測試", "now": "目前走到哪一棒", "note": "提到的公司在哪一棒"}],
 "macro": [{"topic": "總經／利率／匯率／美股等", "view": "看法", "t": "mm:ss"}],
 "data": [{"item": "數據名稱", "val": "數值", "t": "mm:ss"}],
 "risk": [{"text": "風險或反方說法", "by": "講者|AI"}],
 "todo": [{"what": "之後要追蹤什麼", "when": "時間點，例：12/10 營收"}],
 "priced_in": "評價提醒，沒有就空字串"
}
規則：章節 ch 要涵蓋整集、key=true 標出最重要的 2～4 段；risk 至少要有一條 AI 補充的「這個說法要注意什麼」；
節目是閒聊或沒有投資內容時，各欄位可以留空陣列，one 照實寫。不要編造逐字稿沒有的數字。"""


def analyze(it, tr):
    body = '\n'.join(f'[{fmt_ts(s)}] {t}' for s, t in tr)
    if len(body) > 150000:
        body = body[:150000] + '\n…（後面太長截掉）'
    head = f"節目：{it['ch']}\n標題：{it['title']}\n日期：{it['pub'][:10]}\n節目說明：{it.get('desc', '')[:800]}\n\n逐字稿：\n"
    t, model, _ = gen('smart', [{'text': ANA % '、'.join(INDS)}, {'text': head + body}], js=True, max_out=16384, timeout=600)
    t = t.strip()
    t = re.sub(r'^```(?:json)?|```$', '', t).strip()
    a = json.loads(t)
    if isinstance(a, list):
        a = a[0] if a else {}
    return a, model


# ============ 循環帳本：比對階段變化／觀點衝突 ============
def stage_of(x):
    try:
        s = int(x.get('stage') or 0)
        return s if 0 <= s <= 6 else 0
    except Exception:
        return 0


def cycle_update(cyc, it, a):
    d = it['pub'][:10]
    chg, conflict = [], []
    rows = [r for r in cyc if r['id'] != it['id']]
    for x in a.get('cyc') or []:
        s = stage_of(x)
        ind = str(x.get('ind') or '').strip()
        if not ind or not s:
            continue
        prev = [r for r in rows if r['ind'] == ind and r['d'] <= d]
        prev.sort(key=lambda r: (r['d'], r['at']))
        if prev and prev[-1]['stage'] != s:
            p = prev[-1]
            chg.append({'ind': ind, 'from': p['stage'], 'to': s, 'later': s > p['stage'], 'pch': p['ch'], 'pd': p['d']})
        d14 = (datetime.fromisoformat(d) - timedelta(days=14)).strftime('%Y-%m-%d')
        other = [r for r in prev if r['ch'] != it['ch'] and r['d'] >= d14 and abs(r['stage'] - s) >= 2]
        if other:
            o = other[-1]
            conflict.append({'ind': ind, 'me': s, 'other': o['stage'], 'och': o['ch'], 'od': o['d']})
        cyc.append({'d': d, 'at': it['pub'], 'id': it['id'], 'ch': it['ch'], 'ind': ind, 'stage': s, 'side': x.get('side') or '—',
                    'fact': x.get('fact') or '', 'ev': str(x.get('ev') or '')[:120], 't': x.get('t') or ''})
    return chg, conflict


# ============ 主流程 ============
def main():
    if not KEY:
        log('沒有 GEMINI_API_KEY，不做')
        return
    os.makedirs(OUT, exist_ok=True)
    src = json.load(open(os.path.join(os.path.dirname(__file__), 'sources.json'), encoding='utf-8'))
    idx = jload('index.json', {}).get('items', [])
    state = jload('state.json', {})
    cyc = jload('cycle.json', [])
    first = not state.get('seen')
    seen = state.get('seen', {})
    items = {x['id']: x for x in idx}
    cut3 = iso(now() - timedelta(days=3))

    found = []
    for s in src['pod']:
        found += pod_items(s)
    for s in src['yt']:
        found += yt_items(s)
    newest = {}
    for x in found:
        if x['ch'] not in newest or x['pub'] > newest[x['ch']]['pub']:
            newest[x['ch']] = x
    for x in found:
        if x['id'] in items or x['id'] in seen:
            continue
        seen[x['id']] = iso(now())
        if x['pub'] < cut3:
            continue                                   # 太舊的不補
        if first and newest[x['ch']]['id'] != x['id']:
            x['st'] = 'new'                            # 第一次跑：每個節目只自動解析最新一集，其他放清單
        else:
            x['st'] = 'todo' if x['tier'] == 'auto' else 'new'
        items[x['id']] = x
        log('新集數', x['ch'], x['title'][:40], x['st'])

    # Telegram 按鈕／貼連結 要求的
    for r in REQ:
        if r in items:
            if items[r].get('st') != 'done':
                items[r]['st'], items[r]['pri'] = 'todo', 1
            continue
        if re.match(r'^https?://', r):
            x = resolve_req(r)
            if not x:
                ERRS.append('看不懂的連結：' + r[:120])
                continue
            x['req'] = r
            if x['id'] in items:
                items[x['id']]['req'] = r
                if items[x['id']].get('st') != 'done':
                    items[x['id']]['st'], items[x['id']]['pri'] = 'todo', 1
            else:
                x['st'], x['pri'] = 'todo', 1
                items[x['id']] = x

    pick_models()
    todo = sorted([x for x in items.values() if x.get('st') == 'todo'], key=lambda x: (-(x.get('pri') or 0), x['pub']), reverse=False)
    todo.sort(key=lambda x: (-(x.get('pri') or 0), -(datetime.fromisoformat(x['pub']).timestamp())))
    nauto = 0
    for it in todo:
        if time.time() > DEADLINE - 6 * 60:
            log('時間不夠，剩下的下次做')
            break
        if not it.get('pri'):
            if nauto >= MAX_AUTO:
                continue
            nauto += 1
        t0 = time.time()
        try:
            log('▶ 解析', it['ch'], it['title'][:50])
            tr, m1 = transcribe_audio(it) if it['src'] == 'pod' else transcribe_yt(it)
            if not tr:
                raise RuntimeError('逐字稿是空的')
            a, m2 = analyze(it, tr)
            chg, conflict = cycle_update(cyc, it, a)
            stk = [{'c': str(s.get('c') or '').strip().upper(), 'n': str(s.get('n') or '').strip(), 'v': s.get('v') or '中性'} for s in a.get('stk') or [] if s.get('n') or s.get('c')]
            note = {'id': it['id'], 'src': it['src'], 'ch': it['ch'], 'title': it['title'], 'url': it['url'], 'pub': it['pub'], 'dur': it.get('dur') or (tr[-1][0] if tr else 0),
                    'audio': it.get('audio', ''), 'm': [m1, m2], 'at': iso(now()), 'tr': tr, 'a': a, 'chg': chg, 'conflict': conflict}
            jsave(f"n/{it['id']}.json", note)
            it.update({'st': 'done', 'one': a.get('one', ''), 'bias': a.get('bias', ''), 'tags': (a.get('tags') or [])[:5], 'stk': stk[:12],
                       'inds': [{'ind': x.get('ind'), 's': stage_of(x)} for x in a.get('cyc') or [] if x.get('ind')][:8],
                       'chg': chg, 'conflict': conflict, 'alert': bool([c for c in chg if c['later']] or conflict),
                       'hl': (a.get('hl') or [])[:5], 'done': iso(now()), 'dur': note['dur'], 'm': m2})
            it.pop('pri', None)
            it.pop('err', None)
            log('  ✓', round(time.time() - t0), '秒', a.get('one', '')[:40])
        except Exception as e:
            it['tries'] = (it.get('tries') or 0) + 1
            it['err'] = str(e)[:200]
            it['st'] = 'err' if it['tries'] >= 3 else 'todo'
            ERRS.append(f"{it['ch']} {it['title'][:30]}：{e}")
            log('  ✗', e)
            if '額度' in str(e) or '時間用完' in str(e):
                break
        # 做完一集就先存，萬一後面逾時也不會白做
        save(items, state, seen, cyc)

    save(items, state, seen, cyc)
    log('完成，花了', round(time.time() - T0), '秒；模型用量', USED)


def save(items, state, seen, cyc):
    k1 = iso(now() - timedelta(days=KEEP_ITEMS_DAYS))
    keep = sorted([x for x in items.values() if x['pub'] >= k1 or x.get('st') == 'todo'], key=lambda x: x['pub'], reverse=True)
    pub = [{k: v for k, v in x.items() if k not in ('desc', 'audio')} for x in keep]
    jsave('index.json', {'updated': iso(now()), 'stages': STAGES, 'items': pub,
                         'sources': json.load(open(os.path.join(os.path.dirname(__file__), 'sources.json'), encoding='utf-8'))})
    k2 = (now() - timedelta(days=KEEP_CYCLE_DAYS)).strftime('%Y-%m-%d')
    jsave('cycle.json', [r for r in cyc if r['d'] >= k2])
    k3 = iso(now() - timedelta(days=60))
    state['seen'] = {k: v for k, v in seen.items() if v >= k3}
    state['last'] = {'at': iso(now()), 'log': LOG[-40:], 'errs': ERRS[-20:], 'used': USED}
    jsave('state.json', state)
    # 筆記保留 120 天
    nd = os.path.join(OUT, 'n')
    if os.path.isdir(nd):
        k4 = (now() - timedelta(days=KEEP_NOTE_DAYS)).strftime('%Y-%m-%d')
        live = {x['id'] for x in keep} | {r['id'] for r in cyc if r['d'] >= k4}
        for f in os.listdir(nd):
            if f[:-5] not in live:
                os.remove(os.path.join(nd, f))


if __name__ == '__main__':
    main()
