#!/usr/bin/env python3
"""Локальный сервер карты «Грунт рядом».

    python3 server.py            сайт на http://localhost:8765, заявки уходят на GitHub
    python3 server.py --no-push  только сохранять в listings.json
"""
import datetime, json, math, os, re, subprocess, sys, threading, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.join(ROOT, 'listings.json')
PUSH = '--no-push' not in sys.argv
HOSTS = {'localhost:%d' % PORT, '127.0.0.1:%d' % PORT}
LOCK = threading.Lock()
LIMITS = {'place': 200, 'company': 120, 'contact': 120, 'note': 600, 'kind': 60}


class Bad(Exception):
    pass


def load():
    with open(FILE, encoding='utf-8') as f:
        return json.load(f)['items']


def save(items):
    tmp = FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('{"items": [\n' + ',\n'.join(json.dumps(i, ensure_ascii=False) for i in items) + '\n]}\n')
    os.replace(tmp, FILE)   # при сбое посреди записи старый файл остаётся целым


def phone(v):
    d = re.sub(r'\D', '', str(v or ''))
    if not d:
        return ''
    if not re.fullmatch(r'7\d{10}', d):
        raise Bad('Проверьте номер телефона.')
    return '+' + d


def num(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.0
    return n if math.isfinite(n) else 0.0


def check(o):
    if not isinstance(o, dict):
        raise Bad('Пустая заявка.')
    it = {'type': o.get('type'), 'volume': num(o.get('volume')), 'lat': num(o.get('lat')), 'lng': num(o.get('lng')),
          'phone': phone(o.get('phone')), 'whatsapp': phone(o.get('whatsapp'))}
    for k, n in LIMITS.items():
        it[k] = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(o.get(k) or '')).strip()[:n]
    if it['type'] not in ('have', 'need'):
        raise Bad('Не выбран тип заявки.')
    if not 0 < it['volume'] <= 1000000:
        raise Bad('Проверьте объём.')
    if not it['place'] or not it['kind']:
        raise Bad('Укажите адрес и вид грунта.')
    if not (54.15 <= it['lat'] <= 57.05 and 34.9 <= it['lng'] <= 40.5):
        raise Bad('Точка должна быть в Москве или области.')
    if not it['phone'] and not it['whatsapp']:
        raise Bad('Укажите телефон.')
    if it['volume'] == int(it['volume']):
        it['volume'] = int(it['volume'])
    it['title'] = '%s %s м³ %s' % ('Есть' if it['type'] == 'have' else 'Нужно', str(it['volume']).replace('.', ','), it['kind'])
    return it


def git(*args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    return subprocess.run(['git', '-C', ROOT] + list(args), capture_output=True, text=True, timeout=40, env=env)


def publish():
    """Коммитит только listings.json и отправляет на GitHub. Возвращает, получилось ли."""
    if not PUSH:
        return False
    try:
        git('add', '--', 'listings.json')
        if git('diff', '--cached', '--quiet', '--', 'listings.json').returncode:
            c = git('commit', '-m', 'Заявки с карты', '--', 'listings.json')
            if c.returncode:
                print('git commit:', c.stderr.strip(), file=sys.stderr)
                return False
        r = git('push', 'origin', 'HEAD:main')
        if r.returncode:
            print('git push:', r.stderr.strip(), file=sys.stderr)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError) as e:
        print('git:', e, file=sys.stderr)
        return False


def handle(body):
    action, uid = body.get('action'), str(body.get('id') or '')
    with LOCK:
        items = load()
        cur = next((i for i in items if i['id'] == uid), None)
        if action == 'delete':
            if not cur:
                raise Bad('Заявка не найдена.')
            items.remove(cur)
            it = None
        elif action == 'save':
            it = check(body.get('item'))
            it['id'] = uid if re.fullmatch(r's-[0-9a-f]{16}', uid) else 's-' + uuid.uuid4().hex[:16]
            it['date'] = cur['date'] if cur else datetime.date.today().isoformat()
            items = [it] + [i for i in items if i['id'] != it['id']]
        else:
            raise Bad('Неизвестное действие.')
        save(items)
        return {'ok': True, 'item': it, 'published': publish()}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def allowed(self):
        # не пускаем запросы с чужих сайтов, открытых в этом же браузере
        origin = self.headers.get('Origin')
        return self.headers.get('Host') in HOSTS and (not origin or origin.replace('http://', '', 1) in HOSTS)

    def send_head(self):
        if '/.' in unquote(self.path).replace('\\', '/') or not self.allowed():
            self.send_error(403)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path != '/api' or not self.allowed() or not self.headers.get('Origin') \
                or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(403, {'ok': False, 'error': 'Запрос отклонён.'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 20000:
                raise Bad('Слишком большая заявка.')
            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise Bad('Пустая заявка.')
            self.reply(200, handle(body))
        except Bad as e:
            self.reply(200, {'ok': False, 'error': str(e)})
        except Exception as e:
            print('ошибка:', repr(e), file=sys.stderr)
            self.reply(500, {'ok': False, 'error': 'Не удалось сохранить заявку.'})

    def reply(self, code, o):
        data = json.dumps(o, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if self.command == 'POST':
            super().log_message(fmt, *args)


if __name__ == '__main__':
    print('http://localhost:%d' % PORT, '' if PUSH else '(без отправки на GitHub)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
