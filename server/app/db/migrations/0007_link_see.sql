-- Уровень видимости связки. Столбец завели ещё при связках, но со значением «common» — теперь у него
-- те же три уровня, что у человека и заметки: all, clan, hidden. Скрытую связку зритель не видит,
-- и перейти по ней не может.

UPDATE person_links SET visibility = 'all' WHERE visibility = 'common' OR visibility IS NULL;
