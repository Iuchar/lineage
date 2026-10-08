"""Что отдаётся на чтение и кому.

Правка закрыта заслоном, а чтение — нет: оно разбирается по глазам. Здесь проверяется, что
рабочие столы редактора закрыты целиком, а то, что нужно и зрителю, просеивается, а не отдаётся
как есть. Пока в базе нет ни одного редактора, открыто всё: приложение на одном компьютере.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db.access import add_editor
from app.db.clans import import_clan
from app.db.connection import connect
from app.db.editor import PersonFields, update_person
from app.gedcom.load import load_file
from conftest import source

# рабочие столы редактора: зритель на них не заглядывает ни в каком виде
EDITOR_ONLY = [
    "/api/persons?q=а",
    "/api/persons/{person}/form",
    "/api/persons/{person}/delete-preview",
    "/api/links",
    "/api/links/candidates",
    "/api/clans/{clan}/tags/Воин/usage",
    "/api/dates/parse?text=1920",
]


@pytest.fixture()
def world(tmp_path: Path, monkeypatch) -> Iterator[dict]:
    import app.config
    import app.main

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    conn = connect(path)
    import_clan(conn, "Гленн Уриск", load_file(source("Гленн Уриск")))
    family = next(
        row for row in conn.execute("SELECT id FROM families WHERE clan_id = 1")
        if conn.execute("SELECT count(*) FROM family_children WHERE family_id = ?", (row["id"],)).fetchone()[0] > 1
    )["id"]
    kid = conn.execute(
        "SELECT person_id FROM family_children WHERE family_id = ? ORDER BY position", (family,)
    ).fetchone()[0]
    name = conn.execute("SELECT given, surname FROM persons WHERE id = ?", (kid,)).fetchone()
    update_person(conn, kid, PersonFields(given=name["given"], surname=name["surname"], see="hidden"))
    add_editor(conn, "Tyr", "длинный пароль")
    conn.close()

    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    yield {"editor": editor, "guest": TestClient(app.main.app), "family": family, "hidden": kid,
           "other": next(p["id"] for p in editor.get("/api/clans/1/tree").json()["persons"] if p["id"] != kid)}


def test_editor_desks_are_closed_to_a_guest(world: dict) -> None:
    for pattern in EDITOR_ONLY:
        url = pattern.format(person=world["other"], clan=1)
        assert world["guest"].get(url).status_code == 401, f"{url} открыт постороннему"
        assert world["editor"].get(url).status_code != 401, f"{url} закрылся и от редактора"


def test_family_card_hides_the_hidden_child(world: dict) -> None:
    """Карточка союза нужна и зрителю — он открывает её щелчком. Но скрытого ребёнка в ней быть не должно:
    иначе зритель узнаёт, что у пары есть кто-то ещё, кого ему не показывают."""
    at_editor = world["editor"].get(f"/api/families/{world['family']}/form").json()
    assert world["hidden"] in [c["id"] for c in at_editor["children"]]

    answer = world["guest"].get(f"/api/families/{world['family']}/form")
    assert answer.status_code == 200, "зритель должен открывать карточку союза"
    kids = [c["id"] for c in answer.json()["children"]]
    assert world["hidden"] not in kids
    assert len(kids) == len(at_editor["children"]) - 1
    # родство оставшихся не съехало вместе с вычеркнутым
    assert [c["pedigree"] for c in answer.json()["children"]] == \
           [c["pedigree"] for c in at_editor["children"] if c["id"] != world["hidden"]]


def test_hidden_spouse_leaves_the_family_card(world: dict, tmp_path: Path) -> None:
    """Скрытый супруг так же уходит из карточки союза: союз остаётся, человека в нём нет."""
    import app.main

    tree = world["editor"].get("/api/clans/1/tree").json()
    family = next(f for f in tree["families"] if f["husband"] is not None and f["wife"] is not None)
    husband = next(p for p in tree["persons"] if p["id"] == family["husband"])
    conn = connect(app.main.DB_PATH)
    update_person(conn, husband["id"],
                  PersonFields(given=husband["given"], surname=husband["surname"], see="hidden"))
    conn.close()

    at_guest = world["guest"].get(f"/api/families/{family['id']}/form").json()
    assert at_guest["husband"] is None
    assert at_guest["wife"] == family["wife"]


def test_clan_list_and_photos_stay_open(world: dict) -> None:
    """Список родословных и снимки нужны любому: зритель видит общий слой каждого рода."""
    assert world["guest"].get("/api/clans").status_code == 200
    assert world["guest"].get("/api/health").status_code == 200


def test_api_description_is_for_the_editor(world: dict) -> None:
    """Описание API само по себе не данные, но показывает всю поверхность приложения разом.
    Постороннему оно ни к чему, а редактору пригождается."""
    for url in ("/api/docs", "/api/openapi.json"):
        assert world["guest"].get(url).status_code == 401, f"{url} открыт постороннему"
        assert world["editor"].get(url).status_code == 200, f"{url} закрылся и от редактора"


def test_hidden_person_card_does_not_exist_for_a_guest(world: dict) -> None:
    """Скрытого нет в дереве зрителя — значит и по номеру его нет. Номера идут подряд и перебираются,
    так что карточка обязана отвечать так же, как на несуществующего человека."""
    hidden = world["guest"].get(f"/api/persons/{world['hidden']}")
    missing = world["guest"].get("/api/persons/999999")
    assert hidden.status_code == 404
    assert hidden.json() == missing.json()  # ответ не отличает «скрыт» от «нет такого»

    # обычный человек открывается, редактор видит и скрытого
    assert world["guest"].get(f"/api/persons/{world['other']}").status_code == 200
    assert world["editor"].get(f"/api/persons/{world['hidden']}").status_code == 200
    # редактор, глядящий глазами зрителя, скрытого тоже не видит
    assert world["editor"].get(f"/api/persons/{world['hidden']}?as_viewer=0").status_code == 404
    assert world["editor"].get(f"/api/persons/{world['hidden']}?as_viewer=1").status_code == 404


def test_life_dates_in_the_card_follow_the_person_level(world: dict) -> None:
    """Годы жизни у человека родовые по умолчанию: в дереве общему зрителю они закрыты.
    Карточка обязана держать то же правило — иначе закрытое в дереве читается щелчком по человеку."""
    import app.main
    from app.db.share import issue

    tree = world["editor"].get("/api/clans/1/tree").json()
    person = next(p for p in tree["persons"] if p["birth"] and p["see_dates"] == "clan" and p["id"] != world["hidden"])

    def life_dates(client, suffix: str = "") -> list:
        card = client.get(f"/api/persons/{person['id']}{suffix}").json()
        return [e["date"] for e in card["events"] if e["tag"] in ("BIRT", "DEAT") and e["date"]]

    assert life_dates(world["editor"])  # у редактора даты есть
    assert life_dates(world["guest"]) == []  # прохожему — нет, как и в дереве
    assert life_dates(world["editor"], "?as_viewer=0") == []  # редактор глазами общего зрителя
    assert life_dates(world["editor"], "?as_viewer=1")  # глазами своего для рода — есть

    # гость, пришедший по ссылке рода, свой: ему даты открыты
    conn = connect(app.main.DB_PATH)
    key = issue(conn, 1).key
    conn.close()
    invited = TestClient(app.main.app)
    invited.get(f"/r/{key}", follow_redirects=False)
    assert life_dates(invited)

    # дата венчания — общий слой: её видит и прохожий
    family = tree["families"][0]["id"]
    assert world["editor"].put(f"/api/families/{family}", json={"marriage": "1790"}).status_code == 200
    assert world["guest"].get(f"/api/families/{family}/form").json()["marriage"]["gedcom"] == "1790"


def test_tree_says_when_dates_are_closed_rather_than_unknown(world: dict) -> None:
    """Пустая дата бывает двух родов: год не записан и год закрыт от этих глаз. Интерфейс пишет
    «год неизвестен» только в первом случае, поэтому дерево помечает второй."""
    def person(client, suffix: str = "") -> dict:
        tree = client.get(f"/api/clans/1/tree{suffix}").json()
        return next(p for p in tree["persons"] if p["id"] == world["other"])

    assert person(world["editor"])["dates_closed"] is False
    assert person(world["editor"], "?as_viewer=1")["dates_closed"] is False  # свой для рода даты видит
    closed = person(world["guest"])
    assert closed["dates_closed"] is True and closed["birth"] is None and closed["death"] is None


def test_links_do_not_give_away_what_the_tree_hides(tmp_path: Path, monkeypatch) -> None:
    """Связка ведёт к человеку в другом роду — и приносит о нём имя и годы. Она обязана держать те же
    правила, что и дерево того рода: скрытого на том конце нет вовсе, закрытые годы не приходят.
    И имя редактора, поставившего связку, — не для чужих глаз: под ним входят."""
    import app.config
    import app.main

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    houses = Path(__file__).parents[2] / "houses"
    conn = connect(path)
    import_clan(conn, "Хартли", load_file(houses / "Hartley_tree.ged"))
    import_clan(conn, "Дэвис", load_file(houses / "Davis_tree.ged"))
    add_editor(conn, "Tyr", "длинный пароль")
    conn.close()

    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    guest = TestClient(app.main.app)
    pair = editor.get("/api/links/candidates").json()[0]
    here, there = pair["a"]["person"], pair["b"]["person"]
    assert editor.post("/api/links", json={"a": here["id"], "b": there["id"]}).status_code == 200

    def links(client, clan: int, suffix: str = "") -> list[dict]:
        return client.get(f"/api/clans/{clan}/links{suffix}").json()

    seen = links(guest, here["clan_id"])
    assert len(seen) == 1 and seen[0]["other"]["name"]  # связка общая — прохожий её видит
    assert seen[0]["created_by"] is None  # но не того, кто её поставил
    assert seen[0]["other"]["born"] is None and seen[0]["other"]["died"] is None  # годы у человека родовые
    assert seen[0]["other"]["dates_closed"] is True  # и сказано, что закрыты, а не неизвестны
    at_editor = links(editor, here["clan_id"])[0]
    assert at_editor["created_by"] == "Tyr" and at_editor["other"]["born"] == there["born"]
    # свой для ТОГО рода годы видит; свой только для этого — нет
    assert links(editor, here["clan_id"], f"?as_viewer={there['clan_id']}")[0]["other"]["born"] == there["born"]
    assert links(editor, here["clan_id"], f"?as_viewer={here['clan_id']}")[0]["other"]["born"] is None

    # человека на том конце скрыли — связки к нему для зрителя больше нет, с обеих сторон
    conn = connect(path)
    update_person(conn, there["id"], PersonFields(see="hidden"))
    conn.close()
    assert links(guest, here["clan_id"]) == []
    assert links(guest, there["clan_id"]) == []
    assert len(links(editor, here["clan_id"])) == 1


def test_marriage_to_a_hidden_spouse_leaves_no_trace(tmp_path: Path, monkeypatch) -> None:
    """Скрытый не намекает на себя — значит, и брак с ним не должен. Венчание, место и развод говорят,
    что супруг был; зрителю от такого союза остаются только дети, как у одинокого родителя.
    А бездетного союза со скрытым для зрителя нет вовсе: показывать в нём нечего."""
    import app.config
    import app.main

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    conn = connect(path)
    import_clan(conn, "Прайс", load_file(Path(__file__).parents[2] / "houses" / "Pryce_tree.ged"))
    add_editor(conn, "Tyr", "длинный пароль")
    conn.close()
    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    guest = TestClient(app.main.app)

    tree = editor.get("/api/clans/1/tree").json()
    both = [f for f in tree["families"] if f["husband"] and f["wife"]]
    dated = lambda f: editor.get(f"/api/families/{f['id']}/form").json()["marriage"]["gedcom"]  # noqa: E731
    parents = next(f for f in both if f["children"] and dated(f))
    divorced = next(f for f in both if f["divorced"] and f["children"])
    childless = next(f for f in both if not f["children"] and dated(f))
    untouched = next(f for f in both if f["children"] and dated(f) and f not in (parents, divorced))

    conn = connect(path)
    for family in (parents, divorced, childless):
        update_person(conn, family["wife"], PersonFields(see="hidden"))
    conn.close()

    def family_in_tree(family: dict) -> dict | None:
        return next((f for f in guest.get("/api/clans/1/tree").json()["families"] if f["id"] == family["id"]), None)

    def card_marriages(person: int) -> list[int]:
        return [m["family_id"] for m in guest.get(f"/api/persons/{person}").json()["marriages"]]

    # союз с детьми остаётся ради детей, но о браке в нём больше ничего
    kept = family_in_tree(parents)
    assert kept and kept["wife"] is None and kept["children"] == parents["children"]
    form = guest.get(f"/api/families/{parents['id']}/form").json()
    assert form["wife"] is None and form["marriage"]["gedcom"] is None and form["place"] is None
    assert parents["id"] not in card_marriages(parents["husband"])

    # развод со скрытой — тоже след
    assert family_in_tree(divorced)["divorced"] is False
    gone = guest.get(f"/api/families/{divorced['id']}/form").json()
    assert gone["divorced"] is False and gone["divorce"]["gedcom"] is None

    # бездетного союза со скрытой для зрителя нет: ни в дереве, ни карточкой, ни в карточке мужа
    assert family_in_tree(childless) is None
    assert guest.get(f"/api/families/{childless['id']}/form").status_code == 404
    assert childless["id"] not in card_marriages(childless["husband"])
    husband = next(p for p in guest.get("/api/clans/1/tree").json()["persons"] if p["id"] == childless["husband"])
    assert childless["id"] not in husband["spouse_families"]

    # выгрузка зрителя держит то же правило: файл уходит наружу и читается кем угодно
    text = guest.get("/api/clans/1/export").text

    def record(family: dict) -> str | None:
        head = f"0 {family['xref']} FAM\n"
        return text.split(head, 1)[1].split("\n0 ", 1)[0] if head in text else None

    assert "MARR" not in record(parents) and "CHIL" in record(parents)
    assert "DIV" not in record(divorced) and "MARR" not in record(divorced)
    assert record(childless) is None
    assert "MARR" in record(untouched)
    assert f"FAMS {childless['xref']}" not in text  # и ссылки на исчезнувший союз у мужа нет

    # союз, где никто не скрыт, цел: венчание — общий слой
    assert guest.get(f"/api/families/{untouched['id']}/form").json()["marriage"]["gedcom"]
    assert untouched["id"] in card_marriages(untouched["husband"])
    # редактор видит всё как было
    assert editor.get(f"/api/families/{childless['id']}/form").json()["marriage"]["gedcom"]
    assert childless["id"] in [m["family_id"] for m in editor.get(f"/api/persons/{childless['husband']}").json()["marriages"]]


def test_export_drops_a_union_whose_only_members_are_hidden(tmp_path: Path, monkeypatch) -> None:
    """Союз без записанных родителей, где скрыты все дети: в выгрузке зрителя от него не должно
    остаться и пустой записи — она сама была бы намёком на скрытых."""
    import app.config
    import app.main

    path = tmp_path / "base.sqlite3"
    monkeypatch.setattr(app.config, "DB_PATH", path)
    monkeypatch.setattr(app.main, "DB_PATH", path)
    conn = connect(path)
    import_clan(conn, "Прайс", load_file(Path(__file__).parents[2] / "houses" / "Pryce_tree.ged"))
    add_editor(conn, "Tyr", "длинный пароль")
    conn.close()
    editor = TestClient(app.main.app)
    editor.post("/api/login", json={"name": "Tyr", "password": "длинный пароль"})
    tree = editor.get("/api/clans/1/tree").json()
    orphaned = next(f for f in tree["families"] if not f["husband"] and not f["wife"] and f["children"])
    # у союза без родителей появляется дата — чтобы в записи было что-то кроме людей
    assert editor.put(f"/api/families/{orphaned['id']}", json={"marriage": "1820"}).status_code == 200
    conn = connect(path)
    for child in orphaned["children"]:
        update_person(conn, child, PersonFields(see="hidden"))
    conn.close()

    text = TestClient(app.main.app).get("/api/clans/1/export").text
    assert f"0 {orphaned['xref']} FAM" not in text
    assert f"0 {orphaned['xref']} FAM" in editor.get("/api/clans/1/export").text


def test_photo_file_follows_the_portrait_level(world: dict) -> None:
    """Дерево не отдаёт зрителю адрес закрытого портрета — но сам файл отдавался любому, кто адрес знает.
    А знает его всякий, кто видел портрет раньше или получил ссылку. Файл обязан держать те же уровни."""
    import app.main
    from app.db.share import issue

    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
                        "0000000d49444154789c6360000002000001e221bc330000000049454e44ae426082")
    who = world["other"]
    assert world["editor"].post(f"/api/persons/{who}/photo", content=png,
                                headers={"Content-Type": "image/png"}).status_code == 200
    url = next(p for p in world["editor"].get("/api/clans/1/tree").json()["persons"] if p["id"] == who)["photo"]
    assert url and url.startswith("/api/photos/")

    conn = connect(app.main.DB_PATH)
    key = issue(conn, 1).key
    conn.close()
    invited = TestClient(app.main.app)
    invited.get(f"/r/{key}", follow_redirects=False)

    def level(**fields) -> None:
        conn = connect(app.main.DB_PATH)
        update_person(conn, who, PersonFields(**fields))
        conn.close()

    assert world["guest"].get(url).status_code == 200  # портрет общий — виден всем
    level(see_portrait="clan")
    assert world["guest"].get(url).status_code == 404  # родовой: прохожему нет…
    assert invited.get(url).status_code == 200  # …а своему для рода — да
    level(see_portrait="hidden")
    assert invited.get(url).status_code == 404
    assert world["editor"].get(url).status_code == 200  # редактор видит всегда
    level(see_portrait="all", see="hidden")
    assert world["guest"].get(url).status_code == 404  # человек скрыт — и снимка его нет
    assert invited.get(url).status_code == 404
    # файл чужого рода под номером этого человека не достать
    assert world["guest"].get(url.replace("/photos/1/", "/photos/2/")).status_code == 404
