"""
YouTube 財經筆記（J-System）— 原始版本由 Gemini 設計，Claude 整理進 Atlas
  ・每天抓 12 個頻道最新影片（YouTube RSS，免金鑰）
  ・用 Gemini 做投資決策卡（GEMINI_API_KEY 放在 GitHub Secrets；沒有 key 就只存影片說明）
  ・已經分析過的影片不再送 Gemini（省 Gemini 額度）；保留 30 天
輸出：latest_intel.json、meta.json（發佈到 yt-data 分支，Atlas 直接讀）
"""
import os, re, sys, json, time
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-2.5-flash')   # 1.5 系列已停用
GEMINI_ENDPOINT = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent'
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else 'yt-out'
OUT = os.path.join(OUT_DIR, 'latest_intel.json')
KEEP_DAYS = 30
MAX_PER_CHANNEL = 3

TRACKED_CHANNELS = [
    {"name": "游庭皓的財經皓角", "channel_id": "UC0lbAQVpenvfA2QqzsRtL_g", "type": "總體經濟與國際股市"},
    {"name": "理財達人秀 EBCmoneyshow", "channel_id": "UCQvsuaih5lE0n_Ne54nNezg", "type": "台股盤勢與族群選股"},
    {"name": "投資優我罩—優分析", "channel_id": "UCmBQRXvXkeYVBT8nZykMfWw", "type": "產業拆解與法人數據"},
    {"name": "KY99價值投資地下室", "channel_id": "UCVyPg9M-YLDF3UZf6QLtWiA", "type": "價值投資與估值邏輯"},
    {"name": "Gooaye 股癌", "channel_id": "UC23rnlQU_qE3cec9x709peA", "type": "美台股產業動態與心態分享"},
    {"name": "統一投顧", "channel_id": "UCsaU-82xFFTd1dZk8P53pAw", "type": "專業機構盤後與個股報告"},
    {"name": "統一證券", "channel_id": "UCH-_jIlROuTFNtoQmUOhcoQ", "type": "券商晨會與市場動態"},
    {"name": "林睿閎分析師-John", "channel_id": "UCXB8cCqwOHP3BmyhYLAUs0g", "type": "籌碼技術面與波段操作"},
    {"name": "辣個分析師-黎志建(Vic)", "channel_id": "UCkf2mVeZAK7JUwR9JzeVlkQ", "type": "總經與大盤關鍵轉折"},
    {"name": "財女珍妮", "channel_id": "UCdwPn2TO60Ec8QDIFRx50lQ", "type": "美股產業趨勢與企業拆解"},
    {"name": "財經希引力", "channel_id": "UCBES_XBcxRVyMUA9Ue9sy1g", "type": "台美股熱門話題與總經解讀"},
    {"name": "MoneyDJ理財網", "channel_id": "UC8qLLXh5cuY_jtvOHsSYmTA", "type": "第一線產業深度訪談與新聞"},
]

ANALYSIS_PROMPT = """
你是一位嚴守投資紀律、客觀理性、專注於基本面與產業供需的資深分析師。
請根據提供的 YouTube 影片資訊或逐字稿，過濾所有情緒化誇大與標題黨詞彙，直接輸出純 JSON 格式的客觀數據分析：

輸出格式必須嚴格符合以下結構：
{
  "summary": "150字以內的客觀核心結論（大盤方向、關鍵數據、點名個股）",
  "decision_card": {
    "industry_stage": "產業所處階段（例如：第4棒後段測試設備量增期、CCL價漲期後段等）",
    "profit_driver": "獲利主要來源（出貨量 ＞ 規格升級 ＞ 純漲價）",
    "valuation_timeline": "目前股價已反映之時間軸（例如：已反映至2027E EPS）",
    "revision_nature": "上下修性質判讀（需求端驅動或認列時程遞延）"
  },
  "key_metrics": [
    {"label": "指標名稱", "val": "具體數據"}
  ],
  "mentioned_stocks": ["股票代號與名稱"],
  "action_discipline": "具體操作紀律（如：融資使用率偏高不追、長多回測長天期均線承接等）"
}
資訊不足以判斷的欄位請填空字串，不要編造。台股請寫成「代號 名稱」，例如「2330 台積電」。
"""

NS = {'atom': 'http://www.w3.org/2005/Atom', 'yt': 'http://www.youtube.com/xml/schemas/2015', 'media': 'http://search.yahoo.com/mrss/'}


def fetch_latest_videos_from_rss(channel_id, max_videos=MAX_PER_CHANNEL):
    url = f'https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}'
    try:
        resp = requests.get(url, timeout=20, headers={'User-Agent': 'Mozilla/5.0'})
        if resp.status_code != 200:
            print('RSS', resp.status_code, channel_id)
            return []
        root = ET.fromstring(resp.content)
        out = []
        for entry in root.findall('atom:entry', NS)[:max_videos + 3]:
            vid = entry.find('yt:videoId', NS).text
            title = entry.find('atom:title', NS).text or ''
            link = entry.find('atom:link', NS).attrib.get('href', f'https://www.youtube.com/watch?v={vid}')
            if '#short' in title.lower() or '/shorts/' in link:
                continue
            desc = entry.find('.//media:description', NS)
            out.append({'video_id': vid, 'title': title, 'url': link.replace('http://', 'https://'),
                        'published_at': entry.find('atom:published', NS).text, 'description': (desc.text if desc is not None else '') or ''})
            if len(out) >= max_videos:
                break
        return out
    except Exception as e:
        print(f'抓取頻道 {channel_id} 失敗: {e}')
        return []


def gemini(video):
    if not GEMINI_API_KEY:
        return None
    content = f"影片標題: {video['title']}\n影片網址: {video['url']}\n影片說明與主要內容:\n{video['description'][:4000]}"
    payload = {'contents': [{'parts': [{'text': ANALYSIS_PROMPT}, {'text': content}]}],
               'generationConfig': {'temperature': 0.1, 'responseMimeType': 'application/json'}}
    for i in range(4):
        try:
            r = requests.post(GEMINI_ENDPOINT, json=payload, headers={'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY}, timeout=90)
            if r.status_code == 200:
                txt = r.json()['candidates'][0]['content']['parts'][0]['text']
                return json.loads(txt)
            if r.status_code in (429, 500, 503):
                time.sleep(20 * (i + 1))
                continue
            print(f'Gemini 錯誤 [{r.status_code}]: {r.text[:300]}')
            return None
        except Exception as e:
            print(f'呼叫 Gemini 失敗: {e}')
            time.sleep(5)
    return None


def codes_of(stocks, text=''):
    s = ' '.join(stocks or []) + ' ' + text
    return sorted(set(re.findall(r'(?<!\d)(\d{4}[A-Z]?|00\d{3,4}[A-Z]?)(?!\d)', s)))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    old = {}
    if os.path.exists(OUT):
        try:
            old = {x['id']: x for x in json.load(open(OUT, encoding='utf-8'))}
        except Exception:
            old = {}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    recs = {k: v for k, v in old.items() if v.get('publish_time', '') >= cutoff}
    new_ai = 0
    for ch in TRACKED_CHANNELS:
        for v in fetch_latest_videos_from_rss(ch['channel_id']):
            vid = f"yt-{v['video_id']}"
            prev = recs.get(vid)
            if prev and (prev.get('ai') or not GEMINI_API_KEY):
                continue   # 分析過了，不再花 Gemini 額度
            p = gemini(v)
            if p:
                new_ai += 1
                time.sleep(7)   # 免費額度每分鐘次數有限
            desc = re.sub(r'\s+', ' ', v['description']).strip()
            recs[vid] = {
                'id': vid, 'channel_name': ch['name'], 'channel_id': ch['channel_id'], 'channel_type': ch['type'],
                'video_title': v['title'], 'video_url': v['url'], 'publish_time': v['published_at'],
                'summary': (p or {}).get('summary') or desc[:150],
                'decision_card': (p or {}).get('decision_card') or {},
                'key_metrics': (p or {}).get('key_metrics') or [],
                'mentioned_stocks': (p or {}).get('mentioned_stocks') or [],
                'action_discipline': (p or {}).get('action_discipline') or '',
                'codes': codes_of((p or {}).get('mentioned_stocks'), v['title']),
                'ai': bool(p),
            }
    out = sorted(recs.values(), key=lambda x: x['publish_time'], reverse=True)
    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump({'updated': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M'), 'n': len(out), 'new_ai': new_ai,
               'model': GEMINI_MODEL if GEMINI_API_KEY else ''}, open(os.path.join(OUT_DIR, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'完成：共 {len(out)} 支影片，這次新分析 {new_ai} 支')


if __name__ == '__main__':
    main()
