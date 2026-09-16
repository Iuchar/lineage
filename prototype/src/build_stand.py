# -*- coding: utf-8 -*-
"""Собирает стенд: шаблон + встроенные данные обоих родов.

Запуск из папки prototype/src:
    python build_stand.py
Результат: prototype/build/stand.html — самодостаточный файл, открывается двойным кликом.
"""
import io, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # prototype/
DATA = os.path.join(ROOT, 'data')
OUT  = os.path.join(ROOT, 'build', 'stand.html')

G = io.open(os.path.join(DATA, 'gleann-slim.json'), encoding='utf-8').read()
M = io.open(os.path.join(DATA, 'monadh-slim.json'), encoding='utf-8').read()
TPL = io.open(os.path.join(HERE, 'stand_template.html'), encoding='utf-8').read()

html = TPL.replace('/*__GLEANN__*/null', G).replace('/*__MONADH__*/null', M)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
io.open(OUT, 'w', encoding='utf-8').write(html)
print('собрано:', OUT, os.path.getsize(OUT), 'байт')
