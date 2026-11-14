"""
Atlas 影音解析（Podcast＋YouTube → Gemini 完整解析 → 循環帳本）
  ・訂閱清單在 media/sources.json：auto＝新集數自動解析；btn＝放進清單，按「📝 解析」才做
  ・兩段式省額度：① 便宜的 Flash-Lite 聽音檔／看影片 → 逐字稿（含時間）② 比較聰明的 Flash 讀逐字稿 → 重點、個股、循環判斷
  ・v2（11/14）逐字稿一律切 10 分鐘一段＋品質檢查（重複迴圈／沒轉完 → 換模型重轉），記完整度與缺口；
    YouTube 讀不到改抓字幕→音檔（yt-dlp）；頻道清單被擋改用 Apps Script 代抓（MEDIA_FEEDS）；錯誤分類＋下次重試時間
  ・循環帳本 cycle.json：每次判斷都記下來，下一集進來就比對「階段有沒有變、不同節目有沒有打架」
  ・這裡只放公開內容（節目內容、產業判斷）；跟你持股有關的對照在 Atlas／Apps Script 做（不放到公開的 GitHub）
輸出（發佈到 media-data 分支，Atlas 直接讀）：index.json、n/<id>.json、cycle.json、state.json
環境變數：GEMINI_API_KEY、MEDIA_REQ（要解析的 id 或網址，逗號／空白分隔）、MAX_AUTO（這次最多自動解析幾集）
"""
import os, re, sys, json, time, hashlib, base64, subprocess, html as H
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
    """YouTube 頻道新片：先直接讀 RSS；被 YouTube 擋（GitHub 伺服器常被擋）就改用 Apps Script 代抓、隨排程傳進來的清單（MEDIA_FEEDS）"""
    out = []
    try:
        r = requests.get('https://www.youtube.com/feeds/videos.xml?channel_id=' + src['id'], headers=UA, timeout=30)
        root = ET.fromstring(r.content)
        for e in root.findall('atom:entry', NS):
            vid = txt(e, 'yt:videoId', NS)
            title = txt(e, 'atom:title', NS)
            link = (e.find('atom:link', NS).attrib.get('href') if e.find('atom:link', NS) is not None else '') or ''
            g = e.find('media:group', NS)
            desc = txt(g, 'media:description', NS) if g is not None else ''
            yt_add(out, src, vid, title, link, txt(e, 'atom:published', NS), desc)
            if len(out) >= 6:
                break
    except Exception as e:
        rows = FEEDS.get(src['id'])
        if rows:
            for row in rows:
                vid, title, pub, desc = row[:4]
                yt_add(out, src, vid, title, '', pub, desc, row[4] if len(row) > 4 else 0)
                if len(out) >= 6:
                    break
            FEED_VIA['gas'] += 1
        else:
            ERRS.append(f"{src['name']} RSS：{e}")
            FEED_VIA['fail'] += 1
    return out


FEED_VIA = {'gas': 0, 'fail': 0}
try:
    FEEDS = json.loads(os.getenv('MEDIA_FEEDS', '') or '{}')
except Exception:
    FEEDS = {}


def yt_add(out, src, vid, title, link, pub, desc, dur=0):
    if not vid or '#short' in title.lower() or '/shorts/' in link:
        return
    pub = datetime.fromisoformat(pub.replace('Z', '+00:00'))
    out.append({'id': 'yt-' + vid, 'src': 'yt', 'ch': src['name'], 'tier': src['tier'], 'title': title,
                'url': 'https://www.youtube.com/watch?v=' + vid, 'vid': vid, 'pub': iso(pub), 'dur': int(dur or 0), 'desc': (desc or '')[:1500]})


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
DEAD = set()          # 已停用的模型（404），記在 state.json，下次不再浪費重試


class GemErr(RuntimeError):
    """kind：busy 忙線／quota 額度用完／bad 內容被拒（影片讀不到）／time 這次執行時間用完／ytblock YouTube 擋下／empty 空白"""
    def __init__(self, kind, msg):
        super().__init__(msg)
        self.kind = kind


ERR_TXT = {'busy': 'Gemini 忙線中（使用人數太多），稍後自動重試',
           'quota': '今天 Gemini 免費額度用完，明天下午額度重置後自動重試',
           'bad': 'Gemini 讀不到這個影片／音檔（請求被拒）',
           'time': '這次排程時間用完，下次排程接著做',
           'ytblock': 'Gemini 讀不到這支影片，改抓字幕和音檔也被 YouTube 擋下，這支無法解析',
           'empty': 'Gemini 回傳空白內容',
           'net': '連線失敗，稍後自動重試',
           'other': '解析失敗'}
TRANSIENT = {'busy', 'time', 'net', 'empty', 'other'}


def pick_models():
    names = []
    try:
        r = requests.get(G + '/v1beta/models?pageSize=300', headers={'x-goog-api-key': KEY}, timeout=30)
        for m in r.json().get('models', []):
            if 'generateContent' in m.get('supportedGenerationMethods', []):
                names.append(m['name'].split('/')[-1])
    except Exception as e:
        log('查模型失敗', e)
    ver = lambda n: -float(re.findall(r'[\d.]+', n)[0])
    lite = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-flash-lite', n) and n not in DEAD], key=ver)
    smart = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-flash', n) and n not in DEAD], key=ver)
    # 逐字稿：新的 Lite 優先，最後用最新的 2 個 Flash 當備援（舊版用最舊的 Flash，常常已停用）
    MODELS['lite'] = [m for m in dict.fromkeys(lite[:3] + ['gemini-flash-lite-latest'] + smart[:2]) if m not in DEAD]
    MODELS['smart'] = [m for m in dict.fromkeys(['gemini-flash-latest'] + smart[:3] + lite[:1]) if m not in DEAD]
    log('逐字稿模型', MODELS['lite'], '分析模型', MODELS['smart'])


USED = {}
BUSY = {}


def order(kind, shift=0):
    # 這次執行中忙線（503）過兩次的模型排到後面，不要每集都先去撞；shift＝重試時換別的模型先上
    ms = sorted(MODELS[kind], key=lambda m: BUSY.get(m, 0) >= 2)
    if shift and ms:
        shift %= len(ms)
        ms = ms[shift:] + ms[:shift]
    return ms


def gen(kind, parts, js=False, max_out=65536, timeout=900, extra=None, temp=0.2, shift=0):
    """依序試模型；忙線換下一個，全部忙線就等 1 分鐘再整輪試一次；回傳 (文字, 模型, 是否被截斷)；失敗丟 GemErr（有分類）"""
    think = [{'thinkingLevel': 'low'}, {'thinkingBudget': 0}, None]
    codes = []                                   # (模型, 狀態碼)
    for rnd in range(2):
        for model in order(kind, shift):
            if model in DEAD:
                continue
            ex = dict(extra) if extra else None
            for attempt in range(3):
                if time.time() > DEADLINE:
                    raise GemErr('time', ERR_TXT['time'])
                gc = {'temperature': temp, 'maxOutputTokens': max_out}
                if js:
                    gc['responseMimeType'] = 'application/json'
                if think[0]:
                    gc['thinkingConfig'] = think[0]
                if ex:
                    gc.update(ex)
                try:
                    r = requests.post(f'{G}/v1beta/models/{model}:generateContent', headers={'x-goog-api-key': KEY},
                                      json={'contents': [{'parts': parts}], 'generationConfig': gc}, timeout=timeout)
                except Exception as e:
                    ERRS.append(f'{model} 連線 {str(e)[:100]}')
                    codes.append((model, 'net'))
                    break
                if r.status_code == 200:
                    j = r.json()
                    c = (j.get('candidates') or [{}])[0]
                    t = ''.join(p.get('text', '') for p in (c.get('content') or {}).get('parts', []) if not p.get('thought'))
                    USED[model] = USED.get(model, 0) + 1
                    if t.strip():
                        return t, model, c.get('finishReason') == 'MAX_TOKENS'
                    ERRS.append(f'{model} 空白回應 {c.get("finishReason")}')
                    codes.append((model, 'empty'))
                    break
                body = r.text[:300]
                if r.status_code == 400 and 'thinking' in body.lower() and think[0]:
                    think.pop(0)
                    continue
                if r.status_code == 400 and ('mediaResolution' in body or 'media_resolution' in body) and ex:
                    ex = None
                    continue
                ERRS.append(f'{model} {r.status_code} {body[:160]}')
                codes.append((model, r.status_code))
                if r.status_code == 404:
                    DEAD.add(model)              # 已停用 → 記下來，以後不再試
                    break
                if r.status_code == 429:
                    if 'PerDay' in body or 'per day' in body.lower():
                        break                    # 這個模型今天額度用完 → 換下一個
                    time.sleep(45)
                    continue
                if r.status_code in (500, 503, 504):
                    BUSY[model] = BUSY.get(model, 0) + 1
                    time.sleep(8)
                    if attempt >= 1:
                        break
                    continue
                break                            # 400 等其他錯誤 → 換模型
        # 這一輪全部失敗：如果有人只是忙線，等 1 分鐘再整輪試一次
        if rnd == 0 and any(c in (500, 503, 504) for _, c in codes) and time.time() < DEADLINE - 120:
            log('  Gemini 忙線，等 1 分鐘再試一輪')
            time.sleep(60)
            continue
        break
    st = [c for _, c in codes]
    bad_models = {m for m, c in codes if c == 400}
    if len(bad_models) >= 2:
        raise GemErr('bad', ERR_TXT['bad'])
    if any(c in (500, 503, 504) for c in st):
        raise GemErr('busy', ERR_TXT['busy'])
    if st and all(c in (429, 404) for c in st):
        raise GemErr('quota', ERR_TXT['quota'])
    if 'net' in st:
        raise GemErr('net', ERR_TXT['net'])
    if 'empty' in st:
        raise GemErr('empty', ERR_TXT['empty'])
    raise GemErr('other', ERR_TXT['other'] + '：' + ', '.join(str(c) for c in st[:6]))


# ============ 逐字稿：一律切成 10 分鐘一段，每段做品質檢查，不合格就換模型重轉 ============
CHUNK = 10 * 60           # 一段 10 分鐘：輸出短，AI 不容易陷入「同一句一直重複」
OVL = 15                  # 段跟段重疊 15 秒，不會切掉句子
MAX_TRY = 3               # 每段最多試 3 次（每次換模型、換溫度）

TR_RULE = """把內容完整逐字轉成繁體中文逐字稿。規則：
1. 每段一行，行首標時間 [mm:ss]，時間從這段音訊／影片的開頭 00:00 起算；大約每 20～40 秒或換話題就換一行。
2. 保留原意與所有內容，口語贅字可以刪，但不要摘要、不要省略、不要重複前面已經寫過的句子。
3. 業配／廣告段落只寫一行：[mm:ss] （廣告）
4. 股票、公司、英文術語盡量寫對（例如 台積電、CoWoS、HBM、輝達 NVIDIA）。
5. 內容結束就停，不要編造、不要回頭再寫一次。
只輸出逐字稿本身，不要任何說明。"""


def fmt_ts(s):
    s = int(s)
    return f'{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}' if s >= 3600 else f'{s // 60:02d}:{s % 60:02d}'


def parse_tr(t):
    out = []
    for line in t.splitlines():
        m = re.match(r'\s*\[\s*(?:(\d+):)?(\d{1,3}):(\d{2})\s*\]\s*(.*)', line)
        if not m:
            if out and line.strip():
                out[-1][1] += line.strip()
            continue
        s = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        out.append([s, m.group(4).strip()])
    return [x for x in out if x[1]]


def _norm(s):
    return re.sub(r'[\W_]+', '', s)[:24]


def tr_check(lines, span, prev_keys=None):
    """品質檢查：去掉複誦提示詞的行、時間亂跳的行；遇到「開始一直重複」就從那裡切掉。
    回傳 (乾淨的行, 品質) 品質＝{ok, end 轉到第幾秒, rep 重複比例, cut 是否有切掉重複}"""
    prev_keys = prev_keys or set()
    out, keys, rep, cut, last = [], set(), 0, False, -1
    run = 0
    for s, t in lines:
        if ('逐字稿' in t and re.search(r'格式|規則|時間|mm:ss', t)) or 'mm:ss' in t:
            continue                                  # 模型把提示詞唸回來
        if s < last or s > span + 30:
            continue                                  # 時間倒退或超出這段長度 → 不可信
        k = _norm(t)
        dup = len(k) >= 8 and (k in keys or k in prev_keys)
        if dup:
            rep += 1
            run += 1
            if run >= 2:                              # 連續兩行都是重複 → 進入重複迴圈，後面全部不要
                cut = True
                break
            continue
        run = 0
        keys.add(k)
        out.append([s, t])
        last = s
    end = out[-1][0] if out else 0
    ratio = rep / max(1, len(lines))
    need = max(0, span - 120)                         # 最後 2 分鐘可能是片尾，不強求
    ok = bool(out) and not cut and ratio < 0.1 and end >= need
    return out, {'ok': ok, 'end': end, 'rep': round(ratio, 2), 'cut': cut}


def tr_clip(part, span, prev_keys, extra=None, base=0):
    """轉一段（最多試 3 次，每次換模型、換溫度），回傳最好的一次 (行, 模型, 品質, 試了幾次)"""
    best, err = None, None
    for k in range(MAX_TRY):
        ask = TR_RULE + f'\n\n這段長度約 {fmt_ts(span)}。'
        try:
            t, model, _ = gen('lite', [part, {'text': ask}], temp=[0.2, 0.5, 0.3][k], shift=k, extra=extra)
        except GemErr as e:
            err = e
            if e.kind in ('bad', 'quota', 'time', 'ytblock'):
                break
            continue
        raw = parse_tr(t)
        if base and raw and raw[0][0] >= base - 90:
            # 看影片片段時，AI 有時寫「整支影片的時間」（例如 21:30），有時從 00:00 起算 → 統一換成這段的相對時間
            raw = [[x - base, y] for x, y in raw if x - base >= -30]
            raw = [[max(0, x), y] for x, y in raw]
        lines, q = tr_check(raw, span, prev_keys)
        score = (q['ok'], q['end'] * (1 - q['rep']))
        if not best or score > best[0]:
            best = (score, lines, model, q, k + 1)
        if q['ok']:
            break
        log(f'    第 {k + 1} 次品質不合格（轉到 {fmt_ts(q["end"])}／{fmt_ts(span)}，重複 {q["rep"]:.0%}{"，有重複迴圈" if q["cut"] else ""}），換模型重轉')
    if not best:
        raise err or GemErr('empty', ERR_TXT['empty'])
    return best[1], best[2], best[3], best[4]


def merge(tr, lines, base, prev_keys):
    last = tr[-1][0] if tr else -1
    for s, t in lines:
        if base + s > last:
            tr.append([base + s, t])
            prev_keys.add(_norm(t))
            last = base + s


def finish(it, tr, segs, dur, src):
    """算完整度：每段實際轉到哪裡 → 沒轉到的時段列為缺口"""
    gaps, covered = [], 0
    for g in segs:
        got = min(g['e'], g['s'] + g['end'])
        covered += max(0, got - g['s'])
        if g['e'] - got > 120:
            gaps.append([got, g['e']])
    dur = max(dur or 0, (tr[-1][0] + 20) if tr else 0)
    cov = min(100, round(100 * covered / dur)) if dur else 0
    merged = []
    for a, b in gaps:
        if merged and a - merged[-1][1] < 60:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    it['dur'] = int(dur)
    it['q'] = {'cov': cov, 'gaps': merged, 'src': src, 'segs': len(segs), 'retry': sum(g['try'] - 1 for g in segs)}
    log(f'  逐字稿完整度 {cov}%（{len(segs)} 段，重轉 {it["q"]["retry"]} 次）' + (f'，缺 {", ".join(fmt_ts(a) + "～" + fmt_ts(b) for a, b in merged)}' if merged else ''))
    return tr


# ---- 音檔：自己下載、用 ffmpeg 切段，每段直接附在請求裡（不用上傳、不用等處理） ----
WORK = '/tmp/atlas-media'


def download(url, path):
    with requests.get(url, headers=UA, timeout=600, stream=True) as r:
        r.raise_for_status()
        with open(path, 'wb') as f:
            for b in r.iter_content(1 << 20):
                f.write(b)
    return path


def audio_len(path):
    try:
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                             capture_output=True, text=True, timeout=120).stdout.strip()
        return float(out or 0)
    except Exception:
        return 0


def cut_audio(path, start, n, out):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(start), '-t', str(n), '-i', path, '-vn', '-ac', '1', '-ar', '16000',
                    '-b:a', '32k', out], check=True, timeout=300)
    return out


def transcribe_file(it, path, src='audio'):
    L = audio_len(path) or it.get('dur') or 0
    if not L:
        raise RuntimeError('讀不到音檔長度（音檔可能壞掉）')
    tr, segs, keys, model = [], [], set(), ''
    s = 0
    while s < L - 5:
        n = min(CHUNK + OVL, L - s)
        clip = cut_audio(path, s, n, os.path.join(WORK, f'c{int(s)}.mp3'))
        data = base64.b64encode(open(clip, 'rb').read()).decode()
        lines, model, q, k = tr_clip({'inline_data': {'mime_type': 'audio/mp3', 'data': data}}, n, keys)
        merge(tr, lines, s, keys)
        segs.append({'s': s, 'e': s + n, 'end': q['end'], 'ok': q['ok'], 'try': k})
        log(f'    {fmt_ts(s)}～{fmt_ts(s + n)} {"✓" if q["ok"] else "△"} 轉到 {fmt_ts(s + q["end"])}（試 {k} 次）')
        s += CHUNK
    return finish(it, tr, segs, L, src), model


def transcribe_audio(it):
    os.makedirs(WORK, exist_ok=True)
    path = download(it['audio'], os.path.join(WORK, 'ep' + os.path.splitext(it['audio'].split('?')[0])[1][:5]))
    return transcribe_file(it, path, 'audio')


# ---- YouTube：Gemini 直接看影片（10 分鐘一段）；讀不到 → 改抓字幕 → 再不行抓音檔 ----
def transcribe_yt(it):
    try:
        return transcribe_yt_gemini(it)
    except GemErr as e:
        if e.kind != 'bad':
            raise
        log('  Gemini 讀不到這支影片 → 改抓字幕／音檔')
        return transcribe_yt_fallback(it)


def transcribe_yt_gemini(it):
    tr, segs, keys, model, s = [], [], set(), '', 0
    dur = it.get('dur') or 0
    for _ in range(14):                                  # 最多約 2 小時 20 分
        n = min(CHUNK + OVL, dur - s) if dur else CHUNK + OVL
        if n < 5:
            break
        part = {'file_data': {'file_uri': it['url']}, 'video_metadata': {'start_offset': f'{s}s', 'end_offset': f'{s + n}s'}}
        try:
            lines, model, q, k = tr_clip(part, n, keys, extra={'mediaResolution': 'MEDIA_RESOLUTION_LOW'}, base=s)
        except GemErr as e:
            if e.kind == 'bad' and segs:
                break                                    # 已經轉了幾段，後面被拒＝影片結束了
            raise
        merge(tr, lines, s, keys)
        if not lines and segs and not dur:
            break                                        # 不知道片長又轉不出東西＝影片結束了
        segs.append({'s': s, 'e': s + n, 'end': q['end'], 'ok': q['ok'], 'try': k})
        log(f'    {fmt_ts(s)}～{fmt_ts(s + n)} {"✓" if q["ok"] else "△"} 轉到 {fmt_ts(s + q["end"])}（試 {k} 次）')
        if not dur and q['end'] < n - 120 and not q['cut'] and q['rep'] < 0.1:
            segs[-1]['e'] = s + q['end'] + 20            # 不知道片長：這段沒轉滿又沒壞＝影片結束了
            break
        s += CHUNK
        time.sleep(5)
    if not tr:
        raise GemErr('empty', ERR_TXT['empty'])
    return finish(it, tr, segs, dur, 'video'), model


def ytdlp(args, timeout=600):
    return subprocess.run([sys.executable, '-m', 'yt_dlp', '--no-warnings', '--no-playlist'] + args, capture_output=True, text=True, timeout=timeout)


def transcribe_yt_fallback(it):
    os.makedirs(WORK, exist_ok=True)
    base = os.path.join(WORK, 'yt')
    # ① 字幕（人工字幕優先，再來自動字幕）
    r = ytdlp(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh-TW,zh-Hant,zh,zh-Hans,zh-CN,zh.*',
               '--sub-format', 'json3', '--no-simulate', '--print', 'duration', '-o', base + '.%(ext)s', it['url']])
    subs = sorted([f for f in os.listdir(WORK) if f.startswith('yt.') and f.endswith('.json3')], key=lambda f: ('TW' not in f and 'Hant' not in f, f))
    if subs:
        tr = subs_to_tr(json.load(open(os.path.join(WORK, subs[0]), encoding='utf-8')))
        if len(tr) > 10:
            dur = int(float((r.stdout.strip().splitlines() or ['0'])[-1] or 0)) if r.stdout.strip() else 0
            log(f'  用字幕：{subs[0]}，{len(tr)} 行')
            return finish(it, tr, [{'s': 0, 'e': max(dur, tr[-1][0] + 20), 'end': tr[-1][0] + 20, 'ok': True, 'try': 1}], dur, 'subs'), '字幕'
    # ② 音檔
    r2 = ytdlp(['-f', 'bestaudio[ext=m4a]/bestaudio', '-o', base + '.%(ext)s', it['url']], timeout=900)
    aud = [f for f in os.listdir(WORK) if f.startswith('yt.') and not f.endswith('.json3') and not f.endswith('.part')]
    if aud:
        log('  用音檔：' + aud[0])
        return transcribe_file(it, os.path.join(WORK, aud[0]), 'audio')
    why = (r2.stderr or r.stderr or '').strip().splitlines()[-1:] or ['']
    ERRS.append('yt-dlp：' + why[0][:200])
    raise GemErr('ytblock', ERR_TXT['ytblock'])


def subs_to_tr(j):
    """json3 字幕 → 每 25 秒左右一行"""
    out, buf, t0 = [], '', None
    for e in j.get('events', []):
        txt_ = ''.join(s.get('utf8', '') for s in e.get('segs') or []).replace('\n', ' ').strip()
        if not txt_:
            continue
        s = int(e.get('tStartMs', 0) / 1000)
        if t0 is None:
            t0 = s
        buf += txt_ + ' '
        if s - t0 >= 25:
            out.append([t0, buf.strip()])
            buf, t0 = '', None
    if buf.strip():
        out.append([t0 or 0, buf.strip()])
    return out


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
    gaps = (it.get('q') or {}).get('gaps') or []
    gap = ('\n注意：以下時段沒有逐字稿（轉不出來），不要猜那幾段的內容：' + '、'.join(fmt_ts(a) + '～' + fmt_ts(b) for a, b in gaps)) if gaps else ''
    src = '（逐字稿來自 YouTube 字幕，可能是簡體或有錯字，請以繁體中文輸出）' if (it.get('q') or {}).get('src') == 'subs' else ''
    head = f"節目：{it['ch']}\n標題：{it['title']}\n日期：{it['pub'][:10]}\n全長：{fmt_ts(it.get('dur') or tr[-1][0])}（章節 ch 要一路涵蓋到結尾）{gap}{src}\n節目說明：{it.get('desc', '')[:800]}\n\n逐字稿：\n"
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
    cyc[:] = [r for r in cyc if r['id'] != it['id']]      # 重做的那集：舊判斷先拿掉
    rows = list(cyc)
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
    DEAD.update(state.get('dead') or [])
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
        if x['id'] in items and x.get('dur') and not items[x['id']].get('dur'):
            items[x['id']]['dur'] = x['dur']               # 補上片長（Apps Script 代抓的清單有片長）
        if x['id'] in items and x.get('audio') and not items[x['id']].get('audio'):
            items[x['id']]['audio'] = x['audio']           # 補回音檔網址（舊版沒存）
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
                items[r]['st'], items[r]['pri'], items[r]['tries'] = 'todo', 1, 0
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
                    items[x['id']]['st'], items[x['id']]['pri'], items[x['id']]['tries'] = 'todo', 1, 0
            else:
                x['st'], x['pri'] = 'todo', 1
                items[x['id']] = x

    # 舊版做的逐字稿（沒有品質紀錄）重新檢查：只轉到一半、或陷入重複迴圈的 → 用新版重做一次
    for x in items.values():
        q0 = x.get('q') or {}
        if x.get('st') == 'done' and q0.get('src') not in (None, 'old') and q0.get('cov', 100) < 80 and not x.get('redo3'):
            x['st'], x['redo3'], x['pri'], x['tries'] = 'todo', 1, 1, 0      # 完整度太低 → 自動再重做一次
            log(f"完整度只有 {q0.get('cov')}%，再重做一次", x['title'][:30])
            continue
        if x.get('st') == 'done' and 'q' not in x and not x.get('redo2'):
            try:
                nn = jload(f"n/{x['id']}.json", {})
                tr0 = nn.get('tr') or []
                end = tr0[-1][0] if tr0 else 0
                keys, dup = set(), 0
                for _, t in tr0:
                    k = _norm(t)
                    if len(k) >= 8 and k in keys:
                        dup += 1
                    keys.add(k)
                ratio = dup / max(1, len(tr0))
                short = x.get('dur') and end < x['dur'] - 300
                over = x.get('dur') and end > x['dur'] + 120
                if ratio >= 0.05 or short or over:
                    x['st'], x['redo2'], x['pri'], x['tries'] = 'todo', 1, 1, 0
                    log(f"舊逐字稿有問題（重複 {ratio:.0%}{'，沒轉完' if short else ''}{'，時間超出片長' if over else ''}），重做", x['title'][:30])
                else:
                    x['q'] = {'cov': 100 if not x.get('dur') else min(100, round(100 * end / x['dur'])), 'gaps': [], 'src': 'old', 'segs': 0, 'retry': 0}
            except Exception:
                pass
    if FEED_VIA['gas'] or FEED_VIA['fail']:
        log(f"YouTube 頻道清單：直接讀被擋，改用 Apps Script 代抓 {FEED_VIA['gas']} 個、沒有資料 {FEED_VIA['fail']} 個")
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
                    'audio': it.get('audio', ''), 'm': [m1, m2], 'at': iso(now()), 'tr': tr, 'a': a, 'chg': chg, 'conflict': conflict, 'q': it.get('q')}
            jsave(f"n/{it['id']}.json", note)
            it.update({'st': 'done', 'one': a.get('one', ''), 'bias': a.get('bias', ''), 'tags': (a.get('tags') or [])[:5], 'stk': stk[:12],
                       'inds': [{'ind': x.get('ind'), 's': stage_of(x)} for x in a.get('cyc') or [] if x.get('ind')][:8],
                       'chg': chg, 'conflict': conflict, 'alert': bool([c for c in chg if c['later']] or conflict),
                       'hl': (a.get('hl') or [])[:5], 'done': iso(now()), 'dur': note['dur'], 'm': m2, 'trEnd': tr[-1][0]})
            for k in ('pri', 'err', 'errk', 'errat', 'next', 'tries', 'redo', 'redo2'):
                it.pop(k, None)
            log('  ✓', round(time.time() - t0), '秒', a.get('one', '')[:40])
        except Exception as e:
            kind = e.kind if isinstance(e, GemErr) else 'other'
            if kind != 'quota' and kind != 'time':
                it['tries'] = (it.get('tries') or 0) + 1
            it['err'] = str(e)[:200]
            it['errk'] = kind
            it['errat'] = iso(now())
            final = kind in ('bad', 'ytblock') or (it.get('tries') or 0) >= 4
            it['st'] = 'err' if final else 'todo'
            if not final:                         # 下次什麼時候再試（給 Telegram 通知用）
                nx = now() + timedelta(hours=1)
                if kind == 'quota':
                    nx = (now() + timedelta(days=1 if now().hour >= 16 else 0)).replace(hour=16, minute=20)
                it['next'] = iso(nx)
                it['pri'] = it.get('pri') or (1 if it.get('req') else 0)
            ERRS.append(f"{it['ch']} {it['title'][:30]}：[{kind}] {e}")
            log('  ✗', kind, e)
            if kind in ('quota', 'time'):
                break
        # 做完一集就先存，萬一後面逾時也不會白做
        save(items, state, seen, cyc)

    save(items, state, seen, cyc)
    log('完成，花了', round(time.time() - T0), '秒；模型用量', USED)


def save(items, state, seen, cyc):
    k1 = iso(now() - timedelta(days=KEEP_ITEMS_DAYS))
    keep = sorted([x for x in items.values() if x['pub'] >= k1 or x.get('st') == 'todo'], key=lambda x: x['pub'], reverse=True)
    pub = [{k: v for k, v in x.items() if k != 'desc'} for x in keep]
    jsave('index.json', {'updated': iso(now()), 'stages': STAGES, 'items': pub,
                         'sources': json.load(open(os.path.join(os.path.dirname(__file__), 'sources.json'), encoding='utf-8'))})
    k2 = (now() - timedelta(days=KEEP_CYCLE_DAYS)).strftime('%Y-%m-%d')
    jsave('cycle.json', [r for r in cyc if r['d'] >= k2])
    k3 = iso(now() - timedelta(days=60))
    state['seen'] = {k: v for k, v in seen.items() if v >= k3}
    state['last'] = {'at': iso(now()), 'log': LOG[-60:], 'errs': ERRS[-20:], 'used': USED}
    state['dead'] = sorted(DEAD)
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
