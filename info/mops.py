"""
Atlas 公開資訊觀測站（官方 OpenAPI，免金鑰）
  證交所 https://openapi.twse.com.tw  /  櫃買中心 https://www.tpex.org.tw/openapi
輸出（發佈到 info-data 分支，手機直接讀）：
  index.json            哪幾天有資料、各類筆數、更新時間
  d/YYYY-MM-DD.json     當天所有項目（不含長內文）
  b/YYYY-MM-DD/NN.json  重大訊息的「說明」全文（依股號前兩碼分檔，點開才讀）
  c/NN.json             依股號前兩碼分檔：每家公司近 60 天的所有項目（個股頁「📚 資料」用）
  state/*.json          上個月董監持股快照（算持股異動、設質解質用）
類型 k：msg 重大訊息／ann 其他公告／xfer 內部人轉讓申報／hold 內部人持股異動／pledge 設質解質
"""
import json, os, re, sys, time, hashlib
from datetime import datetime, timedelta, timezone
import requests

OUT = sys.argv[1] if len(sys.argv) > 1 else 'info-out'
KEEP_DAYS = 60
TZ = timezone(timedelta(hours=8))
NOW = datetime.now(TZ)
TODAY = NOW.strftime('%Y-%m-%d')
UA = {'User-Agent': 'Mozilla/5.0 (Atlas personal dashboard)', 'Accept': 'application/json'}
TW = 'https://openapi.twse.com.tw/v1/opendata/'
TP = 'https://www.tpex.org.tw/openapi/v1/'
RSS = 'https://mopsov.twse.com.tw/nas/rss/mopsrss201001.xml'   # 觀測站即時重大訊息（前一天 17:30 以後，幾分鐘內就有）
# 每 20 分鐘跑一次時只抓即時重大訊息；整套官方資料（比較大）一天抓 4 次
FULL = os.getenv('FULL') == '1' or not os.path.exists(os.path.join(sys.argv[1] if len(sys.argv) > 1 else 'info-out', 'index.json'))


def get(url):
    for i in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=60)
            if r.status_code == 200:
                j = r.json()
                return j if isinstance(j, list) else []
            print('HTTP', r.status_code, url)
        except Exception as e:
            print('ERR', url, e)
        time.sleep(3 * (i + 1))
    return None


def roc(s):
    """1151110 → 2026-11-10"""
    s = re.sub(r'\D', '', str(s or ''))
    if len(s) < 7:
        return ''
    try:
        return '%04d-%s-%s' % (int(s[:-4]) + 1911, s[-4:-2], s[-2:])
    except ValueError:
        return ''


def hm(s):
    s = re.sub(r'\D', '', str(s or '')).zfill(6)
    return s[:2] + ':' + s[2:4] if s.strip('0') else ''


def g(r, *ks):
    for k in ks:
        for kk in (k, k + ' '):
            if kk in r and str(r[kk]).strip():
                return str(r[kk]).strip()
    return ''


def code_of(r):
    return g(r, '公司代號', 'SecuritiesCompanyCode', '股票代號')


def name_of(r):
    return re.sub(r'\s+', '', g(r, '公司名稱', 'CompanyName'))


def num(s):
    try:
        return float(str(s).replace(',', '').replace('%', '').strip() or 0)
    except ValueError:
        return 0.0


def sh(n):  # 股 → 張
    n = round(n / 1000)
    return f'{n:,} 張'


def iid(*a):
    return hashlib.md5('|'.join(map(str, a)).encode()).hexdigest()[:12]


MSG_TYPES = [
    ('財報', r'財務報(告|表)|財報|自結|季報|年報'), ('營收', r'營收|營業收入'), ('股利', r'股利|配息|配股|除息|除權|盈餘分配'),
    ('庫藏股', r'庫藏'), ('增減資', r'增資|減資|可轉換|公司債|私募|發行新股|認股'), ('法說會', r'法人說明會|法說|業績說明'),
    ('澄清', r'澄清|媒體報導'), ('人事', r'董事長|總經理|發言人|財務主管|會計主管|稽核主管|董事|監察人|經理人|辭任|解任|異動'),
    ('資產交易', r'取得|處分|資產|土地|廠房|設備|投資|合併|收購|分割'), ('背書資金', r'背書|保證|資金貸與'),
    ('股東會', r'股東會|股東常會|臨時會'), ('訴訟處分', r'訴訟|判決|罰鍰|處分|違約'),
]


def msg_type(title):
    for t, p in MSG_TYPES:
        if re.search(p, title):
            return t
    return '其他'


def main():
    os.makedirs(OUT + '/d', exist_ok=True)
    os.makedirs(OUT + '/b', exist_ok=True)
    os.makedirs(OUT + '/state', exist_ok=True)
    cutoff = (NOW - timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
    days, bodies = {}, {}

    # 讀回上次的資料（累積 60 天）
    for f in os.listdir(OUT + '/d'):
        d = f[:-5]
        if d >= cutoff:
            days[d] = {x['id']: x for x in json.load(open(f'{OUT}/d/{f}', encoding='utf-8'))}
        else:
            os.remove(f'{OUT}/d/{f}')
    import shutil
    for f in os.listdir(OUT + '/b'):
        pth = f'{OUT}/b/{f}'
        if os.path.isfile(pth):          # 舊格式（整天一檔）→ 改成依股號前兩碼分檔
            d0 = f[:-5]
            if d0 >= cutoff and d0 in days:
                for k, v in json.load(open(pth, encoding='utf-8')).items():
                    it = days[d0].get(k)
                    if it:
                        bodies.setdefault(d0, {})[it['c'][:2] + k] = v
            os.remove(pth)
        elif f >= cutoff:
            for g2 in os.listdir(pth):
                for k, v in json.load(open(f'{pth}/{g2}', encoding='utf-8')).items():
                    bodies.setdefault(f, {})[g2[:2] + k] = v
        else:
            shutil.rmtree(pth)

    def add(item, body=None):
        d = item['d']
        if not d or d < cutoff or d > TODAY:
            return
        days.setdefault(d, {})[item['id']] = item
        if body:
            bodies.setdefault(d, {})[item['c'][:2] + item['id']] = body[:6000]

    ok = {}
    # ⓪ 即時重大訊息（RSS）：先放進來，之後官方完整資料到了會把同一則換成有全文的版本
    from urllib.parse import unquote_to_bytes
    try:
        r = requests.get(RSS, headers=UA, timeout=40)
        t = r.content.decode('cp950', errors='replace')
        n = 0
        for it in re.findall(r'<item>(.*?)</item>', t, re.S):
            link = (re.search(r'<link>\s*<!\[CDATA\[(.*?)\]\]>', it, re.S) or [None, ''])[1]
            q = dict(re.findall(r'[?&](h\d*\d)=([^&]*)', link))
            vals = {k[-1]: v for k, v in q.items()}   # h…1 股號、h…2 日期、h…3 時間
            typek = (re.search(r'TYPEK=(\w+)', link) or [None, ''])[1]
            if typek not in ('sii', 'otc'):
                continue
            code = vals.get('1', '')
            ds, ts = vals.get('2', ''), vals.get('3', '')
            title = (re.search(r'<description>\s*<!\[CDATA\[(.*?)\]\]>', it, re.S) or [None, ''])[1].strip()
            nm = (re.search(r'<title>\(\w+\)(.*?)-重大訊息</title>', it) or [None, ''])[1]
            if not code or len(ds) != 8 or not title:
                continue
            d, tt = f'{ds[:4]}-{ds[4:6]}-{ds[6:]}', hm(ts)
            title = re.sub(r'\s*\r?\n\s*', '', title)
            key = f'{code}|{d}|{tt}'
            if any(x.get('k') == 'msg' and f"{x['c']}|{x['d']}|{x['t']}" == key and not x.get('u') for x in days.get(d, {}).values()):
                continue   # 已經有官方完整版
            add({'id': iid('msg', code, d, tt, title), 'k': 'msg', 'd': d, 't': tt, 'c': code, 'n': nm, 'm': '上市' if typek == 'sii' else '上櫃',
                 'ty': msg_type(title), 's': title, 'r': '即時', 'u': link.replace('http://', 'https://')})
            n += 1
        ok['rss'] = n
    except Exception as e:
        print('RSS 失敗', e)
        ok['rss'] = None
    if not FULL:
        return finish(days, bodies, ok)

    # ① 重大訊息
    for mkt, url in (('上市', TW + 't187ap04_L'), ('上櫃', TP + 'mopsfin_t187ap04_O')):
        rows = get(url)
        ok['msg_' + mkt] = None if rows is None else len(rows)
        for r in rows or []:
            code, title = code_of(r), g(r, '主旨')
            if not code or not title:
                continue
            d, t = roc(g(r, '發言日期')), hm(g(r, '發言時間'))
            title = re.sub(r'\s*\r?\n\s*', '', title)
            for k0 in [k for k, x in days.get(d, {}).items() if x.get('u') and x['c'] == code and x['t'] == t]:
                del days[d][k0]   # 換掉即時版
            add({'id': iid('msg', code, d, t, title), 'k': 'msg', 'd': d, 't': t, 'c': code, 'n': name_of(r), 'm': mkt,
                 'ty': msg_type(title), 's': title, 'r': ('事實發生日 ' + roc(g(r, '事實發生日'))) if g(r, '事實發生日') else g(r, '符合條款')},
                g(r, '說明'))

    # ② 其他公告：股東會召集公告、經營權異動、違規處分
    rows = get(TW + 't187ap38_L')
    ok['ann_股東會'] = None if rows is None else len(rows)
    for r in rows or []:
        code = code_of(r)
        d = roc(g(r, '公告日期'))
        if not code or not d:
            continue
        kind, md = g(r, '股東常(臨時)會日期-常或臨時'), roc(g(r, '股東常(臨時)會日期-日期'))
        cash = g(r, '預擬配發現金(股利)(元/股)-盈餘')
        s = f'召開股東{kind}（{md}）' + (f'，擬配現金股利 {cash} 元' if cash and num(cash) else '')
        add({'id': iid('ann', 'agm', code, d, md), 'k': 'ann', 'd': d, 't': hm(g(r, '公告時間')), 'c': code, 'n': name_of(r), 'm': '上市',
             'ty': '股東會', 's': s, 'r': '停止過戶 ' + roc(g(r, '停止過戶起訖日期-起')) + '～' + roc(g(r, '停止過戶起訖日期-訖'))})
    for mkt, url in (('上市', TW + 't187ap24_L'), ('上櫃', TP + 'mopsfin_t187ap24_O')):
        rows = get(url)
        ok['ann_經營權_' + mkt] = None if rows is None else len(rows)
        for r in rows or []:
            code, d, s = code_of(r), roc(g(r, '經營權異動日期')), g(r, '經營權異動說明')
            if code and d:
                add({'id': iid('ann', 'ctl', code, d), 'k': 'ann', 'd': d, 't': '', 'c': code, 'n': name_of(r), 'm': mkt,
                     'ty': '經營權異動', 's': re.sub(r'\s+', '', s)[:120], 'r': ''}, s)
    for mkt, url in (('上市', TW + 't187ap23_L'), ('上櫃', TP + 'mopsfin_t187ap23_O')):
        rows = get(url)
        ok['ann_違規_' + mkt] = None if rows is None else len(rows)
        for r in rows or []:
            code, d, s = code_of(r), roc(g(r, '發函日期')), g(r, '違規事由')
            if code and d:
                fine = g(r, '裁罰金額(萬)', '裁罰金額')
                add({'id': iid('ann', 'vio', code, d, s[:40]), 'k': 'ann', 'd': d, 't': '', 'c': code, 'n': name_of(r), 'm': mkt,
                     'ty': '違規處分', 's': re.sub(r'\s+', '', s)[:120], 'r': (f'違約金 {fine} 萬' if fine else '')}, s)

    # ③ 內部人持股轉讓事前申報（含申報後未轉讓）
    for mkt, url, url2 in (('上市', TW + 't187ap12_L', TW + 't187ap13_L'), ('上櫃', TP + 'mopsfin_t187ap12_O', TP + 'mopsfin_t187ap13_O')):
        rows = get(url)
        ok['xfer_' + mkt] = None if rows is None else len(rows)
        for r in rows or []:
            code = code_of(r)
            if not code:
                continue
            d = roc(g(r, '出表日期', 'Date'))
            who, nm, how = g(r, '申報人身分', '申請人身分'), g(r, '姓名', 'Name'), g(r, '預定轉讓方式及股數-轉讓方式')
            n = num(g(r, '預定轉讓總股數-自有持股')) + num(g(r, '預定轉讓總股數-保留運用決定權信託股數'))
            have = num(g(r, '目前持有股數-自有持股'))
            pct = f'（占持股 {n / have * 100:.0f}%）' if have else ''
            add({'id': iid('xfer', code, d, nm, how, n), 'k': 'xfer', 'd': d, 't': '', 'c': code, 'n': name_of(r), 'm': mkt,
                 'ty': how or '轉讓', 's': f'{who} {nm} 申報{how}轉讓 {sh(n)}{pct}',
                 'r': '受讓人：' + (g(r, '受讓人') or '—') + '・有效期間 ' + '～'.join(roc(x) for x in g(r, '有效轉讓期間').split('~'))})
        rows = get(url2)
        for r in rows or []:
            code = code_of(r)
            if not code:
                continue
            d = roc(g(r, '出表日期', 'Date'))
            nm = g(r, '姓名', 'Name')
            n = num(g(r, '未轉讓股數-自有持股', '未轉讓股數自有持股'))
            add({'id': iid('xfer', 'un', code, d, nm, n), 'k': 'xfer', 'd': d, 't': '', 'c': code, 'n': name_of(r), 'm': mkt,
                 'ty': '申報未轉讓', 's': f'{g(r, "申報人身分", "申請人身分")} {nm} 申報後未轉讓 {sh(n)}', 'r': '理由：' + (g(r, '未轉讓理由') or '—')})

    # ④⑤ 董監持股餘額（每月）→ 和上個月比：持股異動、設質解質
    for mkt, url in (('上市', TW + 't187ap11_L'), ('上櫃', TP + 'mopsfin_t187ap11_O')):
        rows = get(url)
        ok['hold_' + mkt] = None if rows is None else len(rows)
        if not rows:
            continue
        ym = g(rows[0], '資料年月')
        if not ym:
            continue
        snap = {}
        for r in rows:
            code = code_of(r)
            if not code:
                continue
            key = f'{code}|{g(r, "職稱")}|{g(r, "姓名", "Name")}'
            snap[key] = [num(g(r, '目前持股')), num(g(r, '設質股數')), name_of(r), num(g(r, '內部人關係人目前持股合計')), num(g(r, '內部人關係人設質股數'))]
        sf = f'{OUT}/state/hold_{mkt}.json'
        prev = json.load(open(sf, encoding='utf-8')) if os.path.exists(sf) else None
        if prev and prev.get('ym') != ym:
            d = roc(g(rows[0], '出表日期', 'Date')) or TODAY
            yms = f'{int(ym[:-2]) + 1911}/{ym[-2:]}'
            pv = prev['snap']
            for key, cur in snap.items():
                code, title, nm = key.split('|', 2)
                old = pv.get(key)
                if not old:
                    continue
                dh, dp = cur[0] - old[0], cur[1] - old[1]
                if abs(dh) >= 1000:
                    add({'id': iid('hold', key, ym), 'k': 'hold', 'd': d, 't': '', 'c': code, 'n': cur[2], 'm': mkt,
                         'ty': '增加' if dh > 0 else '減少', 's': f'{title} {nm} {sh(old[0])} → {sh(cur[0])}（{"+" if dh > 0 else ""}{sh(dh)}）',
                         'r': f'{yms} 月報'})
                if abs(dp) >= 1000:
                    ratio = f'，設質比 {cur[1] / cur[0] * 100:.0f}%' if cur[0] else ''
                    add({'id': iid('pledge', key, ym), 'k': 'pledge', 'd': d, 't': '', 'c': code, 'n': cur[2], 'm': mkt,
                         'ty': '設質' if dp > 0 else '解質', 's': f'{title} {nm} {"設質" if dp > 0 else "解質"} {sh(abs(dp))}（設質 {sh(old[1])} → {sh(cur[1])}{ratio}）',
                         'r': f'{yms} 月報'})
        if not prev or prev.get('ym') != ym:
            json.dump({'ym': ym, 'snap': snap}, open(sf, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

    return finish(days, bodies, ok)


def finish(days, bodies, ok):
    # 寫檔
    old = {}
    if os.path.exists(f'{OUT}/index.json'):
        try:
            old = json.load(open(f'{OUT}/index.json', encoding='utf-8'))
        except Exception:
            old = {}
    ok = dict(old.get('src') or {}, **ok)
    idx = {'updated': NOW.strftime('%Y-%m-%d %H:%M'), 'src': ok, 'days': []}
    for d in sorted(days, reverse=True):
        items = sorted(days[d].values(), key=lambda x: (x.get('t') or '', x['c']), reverse=True)
        json.dump(items, open(f'{OUT}/d/{d}.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        cnt = {}
        for x in items:
            cnt[x['k']] = cnt.get(x['k'], 0) + 1
        idx['days'].append({'d': d, 'n': cnt})
    for d, b in bodies.items():
        os.makedirs(f'{OUT}/b/{d}', exist_ok=True)
        grp = {}
        for k, v in b.items():
            grp.setdefault(k[:2], {})[k[2:]] = v
        for gk, gv in grp.items():
            json.dump(gv, open(f'{OUT}/b/{d}/{gk}.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # 個股頁用：每家公司近 60 天（每類最多 30 則）
    import shutil
    shutil.rmtree(f'{OUT}/c', ignore_errors=True)
    os.makedirs(f'{OUT}/c', exist_ok=True)
    byc = {}
    for d in sorted(days, reverse=True):
        for x in sorted(days[d].values(), key=lambda x: x.get('t') or '', reverse=True):
            lst = byc.setdefault(x['c'], [])
            if sum(1 for y in lst if y['k'] == x['k']) < 30:
                lst.append(x)
    grp = {}
    for c, lst in byc.items():
        grp.setdefault(c[:2], {})[c] = lst
    for gk, gv in grp.items():
        json.dump(gv, open(f'{OUT}/c/{gk}.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    hs = {m: json.load(open(f'{OUT}/state/hold_{m}.json', encoding='utf-8'))['ym'] for m in ('上市', '上櫃') if os.path.exists(f'{OUT}/state/hold_{m}.json')}
    idx['holdYm'] = hs
    print(json.dumps(ok, ensure_ascii=False), len(idx['days']), 'days')
    idx['full'] = old.get('full', '') if not FULL else NOW.strftime('%Y-%m-%d %H:%M')
    json.dump(idx, open(f'{OUT}/index.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    if all(v is None for v in ok.values()):
        sys.exit('全部來源都抓不到')


if __name__ == '__main__':
    main()
