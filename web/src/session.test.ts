import { describe, expect, it } from "vitest";

import { untilText } from "./format";
import { isNewVisit, VISIT_GAP_MS } from "./session";

describe("заход", () => {
  const now = 1_800_000_000_000;

  it("перезагрузка страницы остаётся тем же заходом", () => {
    expect(isNewVisit(String(now - 1500), now)).toBe(false);
    expect(isNewVisit(String(now - VISIT_GAP_MS), now)).toBe(false);
  });

  it("страница, закрытая дольше трёх минут, начинает новый заход", () => {
    expect(isNewVisit(String(now - VISIT_GAP_MS - 1), now)).toBe(true);
    expect(isNewVisit(String(now - 8 * 3600_000), now)).toBe(true);
  });

  it("без отметки или с испорченной заход новый", () => {
    expect(isNewVisit(null, now)).toBe(true);
    expect(isNewVisit("", now)).toBe(true);
    expect(isNewVisit("не число", now)).toBe(true);
  });
});

describe("срок ссылки словами", () => {
  const now = new Date("2026-10-01T12:00:00Z").getTime();

  it("далёкий срок — только дата", () => {
    expect(untilText("2026-12-30T12:00:00+00:00", now)).toBe("до 30 декабря 2026");
  });

  it("в последнюю неделю — ещё и сколько осталось", () => {
    expect(untilText("2026-10-06T12:00:00+00:00", now)).toBe("до 6 октября 2026 · осталось 5 дней");
    expect(untilText("2026-10-04T12:00:00+00:00", now)).toBe("до 4 октября 2026 · осталось 3 дня");
    expect(untilText("2026-10-02T12:00:00+00:00", now)).toBe("до 2 октября 2026 · остался 1 день");
    // пять суток с хвостиком — всё равно пять дней: считаем по календарю
    expect(untilText("2026-10-06T13:00:00+00:00", now)).toBe("до 6 октября 2026 · осталось 5 дней");
    expect(untilText("2026-10-01T13:00:00+00:00", now)).toBe("до 1 октября 2026 · заканчивается сегодня");
  });

  it("вышедший срок так и называется", () => {
    expect(untilText("2026-09-30T12:00:00+00:00", now)).toBe("закончился 30 сентября 2026");
  });
});
