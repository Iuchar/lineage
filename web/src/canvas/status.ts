// Титул рода: те же ключи, что в заголовке файла (server/app/gedcom/meta.py).
export const STATUS_NAMES: Record<string, string> = {
  titled: "титулованный древний благородный род",
  old: "древний благородный род",
  plain: "род без титула",
};

// порядок при сортировке по статусу: титулованные выше
export const STATUS_ORDER = ["titled", "old", "plain"];
