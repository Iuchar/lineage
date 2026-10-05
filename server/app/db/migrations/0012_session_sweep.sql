-- Погасшие сессии подбираются на каждом обращении, поэтому поиск по срокам должен быть дешёвым.
-- Два отдельных указателя, а не один составной: условия проверяются порознь, каждое своим запросом.

CREATE INDEX sessions_seen ON sessions(seen_at);
CREATE INDEX sessions_born ON sessions(created_at);
