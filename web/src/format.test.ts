import { describe, expect, it } from "vitest";
import type { TreePerson } from "./api/types";
import { dotted, lifeYears } from "./format";

const person = (over: Partial<TreePerson>): TreePerson => ({ birth: null, death: null, dates_closed: false, ...over }) as TreePerson;
const year = (y: number) => ({ raw: String(y), kind: "exact", year: y }) as TreePerson["birth"];

describe("годы жизни в подписи", () => {
  it("год не записан — так и сказано", () => {
    expect(lifeYears(person({}))).toBe("год неизвестен");
  });

  it("годы закрыты от этих глаз — на их месте пусто, без «неизвестен»", () => {
    expect(lifeYears(person({ dates_closed: true }))).toBe("");
  });

  it("годы есть — показаны", () => {
    expect(lifeYears(person({ birth: year(1852), death: year(1930) }))).toBe("1852 — 1930");
  });

  it("пустая часть подписи не оставляет повисший разделитель", () => {
    expect(dotted("", "@I1@")).toBe("@I1@");
    expect(dotted("1852 — 1930", "@I1@")).toBe("1852 — 1930 · @I1@");
  });
});
