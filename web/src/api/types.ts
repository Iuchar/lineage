// Типы берутся из описания API сервера: `npm run api` пересобирает schema.d.ts.
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ClanSummary = Schemas["ClanSummary"];
export type ClanTree = Schemas["ClanTree"];
export type TreePerson = Schemas["TreePerson"];
export type TreeFamily = Schemas["TreeFamily"];
export type LifeDate = Schemas["LifeDate"];
export type PersonDetails = Schemas["PersonDetails"];
export type PersonEvent = Schemas["PersonEvent"];
export type UploadInfo = Schemas["UploadInfo"];
export type ClanMatch = Schemas["ClanMatch"];
export type ReloadPreview = Schemas["ReloadPreview"];
export type ReloadReport = Schemas["ReloadReport"];
export type PersonBrief = Schemas["PersonBrief"];
export type PersonChange = Schemas["PersonChange"];
export type LinkPerson = Schemas["LinkPerson"];
export type Link = Schemas["Link"];
export type ClanLink = Schemas["ClanLink"];
export type Kin = Schemas["Kin"];
export type Candidate = Schemas["Candidate"];
export type ChangeInfo = Schemas["ChangeInfo"];
export type PersonForm = Schemas["PersonForm"];
export type PersonFields = Schemas["PersonFields"];
export type NewPerson = Schemas["NewPerson"];
export type Relation = Schemas["Relation"];
export type Created = Schemas["Created"];
export type DeletePreview = Schemas["DeletePreview"];
export type ParsedDate = Schemas["ParsedDate"];
