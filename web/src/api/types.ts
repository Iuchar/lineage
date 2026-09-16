// Типы берутся из описания API сервера: `npm run api` пересобирает schema.d.ts.
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ClanSummary = Schemas["ClanSummary"];
export type ClanTree = Schemas["ClanTree"];
export type TreePerson = Schemas["TreePerson"];
export type TreeFamily = Schemas["TreeFamily"];
export type LifeDate = Schemas["LifeDate"];
