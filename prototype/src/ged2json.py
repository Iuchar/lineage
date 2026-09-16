# -*- coding: utf-8 -*-
"""Разбор GEDCOM 5.5.1 в JSON и подготовка данных для стенда.

    python ged2json.py ../../Monadh_Croibhe_tree.ged ../data/monadh-slim.json

Неизвестные теги сохраняются в поле raw и не теряются.
"""
import io, json, sys


def parse(path):
    people, fams = {}, {}
    cur, curtype, stack = None, None, []
    with io.open(path, encoding='utf-8-sig') as f:
        for raw in f:
            line = raw.rstrip('\n\r')
            if not line.strip():
                continue
            parts = line.split(' ', 2)
            lvl = int(parts[0])
            if lvl == 0:
                tok = parts[1] if len(parts) > 1 else ''
                rest = parts[2] if len(parts) > 2 else ''
                if tok.startswith('@') and rest == 'INDI':
                    cur = {'id': tok.strip('@'), 'fams': [], 'famc': [], 'even': [], 'raw': []}
                    people[cur['id']] = cur; curtype = 'I'
                elif tok.startswith('@') and rest == 'FAM':
                    cur = {'id': tok.strip('@'), 'husb': None, 'wife': None, 'chil': [], 'raw': []}
                    fams[cur['id']] = cur; curtype = 'F'
                else:
                    cur, curtype = None, None
                stack = []
                continue
            if cur is None:
                continue
            tag = parts[1] if len(parts) > 1 else ''
            val = parts[2] if len(parts) > 2 else ''
            if curtype == 'I':
                if lvl == 1:
                    stack = [tag]
                    if tag == 'NAME':   cur['name'] = val
                    elif tag == 'SEX':  cur['sex'] = val
                    elif tag == 'FAMS': cur['fams'].append(val.strip('@'))
                    elif tag == 'FAMC': cur['famc'].append(val.strip('@'))
                    elif tag == 'EVEN': cur['even'].append(val)
                    elif tag in ('BIRT', 'DEAT'): pass
                    else: cur['raw'].append([lvl, tag, val])
                elif lvl == 2:
                    top = stack[0] if stack else ''
                    if tag == 'GIVN':      cur['givn'] = val
                    elif tag == 'SURN':    cur['surn'] = val
                    elif tag == '_MARNM':  cur['marnm'] = val
                    elif tag == 'DATE' and top == 'BIRT': cur['birt'] = val
                    elif tag == 'DATE' and top == 'DEAT': cur['deat'] = val
                    elif tag == 'TYPE':    pass
                    else: cur['raw'].append([lvl, tag, val])
            else:
                if tag == 'HUSB':   cur['husb'] = val.strip('@')
                elif tag == 'WIFE': cur['wife'] = val.strip('@')
                elif tag == 'CHIL': cur['chil'].append(val.strip('@'))
                else: cur['raw'].append([lvl, tag, val])
    return people, fams


def slim(people, fams):
    """Урезанный вид для стенда: только то, что нужно раскладке и отрисовке."""
    out = {'people': {}, 'fams': {}}
    for i, p in people.items():
        out['people'][i] = {'id': i, 'g': p.get('givn', ''), 's': p.get('surn', ''),
                            'x': p.get('sex', ''), 'b': p.get('birt', ''), 'd': p.get('deat', ''),
                            'n': (p.get('even') or [''])[0],
                            'fams': p['fams'], 'famc': p['famc']}
    for i, f in fams.items():
        out['fams'][i] = {'id': i, 'h': f['husb'], 'w': f['wife'], 'c': f['chil']}
    return out


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    people, fams = parse(src)
    stubs = [p['id'] for p in people.values() if p.get('givn') == 'Ветвь']
    print('людей:', len(people), '| семей:', len(fams), '| узлов-заглушек:', len(stubs))
    io.open(dst, 'w', encoding='utf-8').write(
        json.dumps(slim(people, fams), ensure_ascii=False, separators=(',', ':')))
    print('записано:', dst)
