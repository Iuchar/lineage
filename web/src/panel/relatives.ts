// Родня человека по дереву рода: родители, браки по очереди, дети каждого брака, братья и сёстры.

import type { ClanTree, TreeFamily, TreePerson } from "../api/types";
import { primaryFamilies } from "../layout/layout";

export interface Marriage {
  family: TreeFamily;
  spouse: TreePerson | null;
  children: TreePerson[];
}

// семья, где человек записан ребёнком, и его родство с ней
export interface ParentFamily {
  family: TreeFamily;
  father: TreePerson | null;
  mother: TreePerson | null;
  pedigree: string; // birth, adopted, foster
}

export interface Relatives {
  father: TreePerson | null;
  mother: TreePerson | null;
  otherParents: TreePerson[]; // приёмные и прочие семьи, где человек записан ребёнком
  parents: ParentFamily[]; // все семьи-родители; первая — та, под которой человек стоит на карте
  marriages: Marriage[];
  siblings: TreePerson[];
}

export function relativesOf(tree: ClanTree, personId: number): Relatives {
  const persons = new Map(tree.persons.map((p) => [p.id, p]));
  const families = new Map(tree.families.map((f) => [f.id, f]));
  const person = persons.get(personId);
  const get = (id: number | null) => (id != null ? (persons.get(id) ?? null) : null);

  const primary = primaryFamilies(tree).get(personId);
  const parentFamilies = (person?.parent_families ?? [])
    .map((id) => families.get(id))
    .filter((f): f is TreeFamily => f !== undefined)
    .sort((a, b) => Number(b.id === primary) - Number(a.id === primary));
  const parents = parentFamilies.map((family) => ({
    family,
    father: get(family.husband),
    mother: get(family.wife),
    pedigree: family.child_pedigree?.[family.children.indexOf(personId)] ?? "birth",
  }));
  const first = parentFamilies[0];
  const otherParents = parentFamilies
    .slice(1)
    .flatMap((f) => [get(f.husband), get(f.wife)])
    .filter((p): p is TreePerson => p !== null);

  const marriages = (person?.spouse_families ?? [])
    .map((id) => families.get(id))
    .filter((f): f is TreeFamily => f !== undefined)
    .map((family) => ({
      family,
      spouse: get(family.husband === personId ? family.wife : family.husband),
      children: family.children.map((id) => get(id)).filter((p): p is TreePerson => p !== null),
    }));

  const siblings = first
    ? first.children.filter((id) => id !== personId).map((id) => get(id)).filter((p): p is TreePerson => p !== null)
    : [];

  return { father: get(first?.husband ?? null), mother: get(first?.wife ?? null), otherParents, parents, marriages, siblings };
}
