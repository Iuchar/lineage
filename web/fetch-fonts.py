"""Скачивает шрифты из Google Fonts в web/src/fonts и пишет fonts.css. Только подмножества cyrillic и latin.

Запуск из корня проекта, когда меняется набор шрифтов: uv run --project server python web/fetch-fonts.py
"""
import re, urllib.request
from pathlib import Path

URL = ("https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600;700"
       "&family=Playfair+Display:wght@400;700;900&family=PT+Serif:ital,wght@0,400;0,700;1,400"
       "&family=Literata:opsz,wght@7..72,300;7..72,400;7..72,600&family=Caveat:wght@400;600"
       "&family=Golos+Text:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
OUT = Path("web/src/fonts")
KEEP = {"cyrillic", "latin"}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30).read()

css = get(URL).decode()
blocks = re.findall(r"/\* ([\w-]+) \*/\s*(@font-face \{.*?\})", css, re.S)
OUT.mkdir(parents=True, exist_ok=True)
files, faces, total = {}, [], 0
for subset, face in blocks:
    if subset not in KEEP:
        continue
    family = re.search(r"font-family: '([^']+)'", face).group(1)
    style = re.search(r"font-style: (\w+)", face).group(1)
    url = re.search(r"url\((https://[^)]+\.woff2)\)", face).group(1)
    if url not in files:
        name = f"{family.lower().replace(' ', '-')}-{style}-{subset}-{len(files)}.woff2"
        data = get(url)
        (OUT / name).write_bytes(data)
        files[url] = name
        total += len(data)
    faces.append(face.replace(url, "./" + files[url]).replace("format('woff2')", 'format("woff2")'))
header = ("/* Шрифты лежат в проекте, чтобы приложение работало без интернета.\n"
          "   Скачаны из Google Fonts (лицензия SIL Open Font License), подмножества cyrillic и latin. */\n\n")
(OUT / "fonts.css").write_text(header + "\n".join(faces) + "\n", encoding="utf-8")
print(len(files), "файлов,", len(faces), "@font-face,", round(total / 1024), "КБ")
