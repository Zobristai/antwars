import { z } from "zod";
import type { Fields } from "../store/firestore.js";

export const ffaPlace = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Place = z.infer<typeof ffaPlace>;
export const ffaId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const count = z.number().int().nonnegative();
const counts = z.tuple([count, count, count, count]);
const recent = z.array(z.object({ place: ffaPlace, matchId: ffaId })).max(5);
export type PlaceRecord = { places: z.infer<typeof counts>; form: z.infer<typeof recent> };
export const emptyPlaces = (): PlaceRecord => ({ places: [0, 0, 0, 0], form: [] });

export function readPlaces(fields: Fields, ratedMatches: number): PlaceRecord | null {
  if (fields.places === undefined && fields.form === undefined) return ratedMatches ? null : emptyPlaces();
  const places = counts.parse(JSON.parse(fields.places!)), form = recent.parse(JSON.parse(fields.form!));
  if (places.reduce((n, v) => n + v, 0) !== ratedMatches || form.length !== Math.min(5, ratedMatches) ||
      new Set(form.map(v => v.matchId)).size !== form.length || places.some((n, i) => n < form.filter(v => v.place === i + 1).length)) {
    throw new Error("invalid Free-for-all place record");
  }
  return { places, form };
}

export function addPlace(record: PlaceRecord, place: Place, matchId: string): void {
  record.places[place - 1]!++;
  record.form = [{ place, matchId }, ...record.form.slice(0, 4)];
}
export const placeFields = ({ places, form }: PlaceRecord): Fields => ({ places: JSON.stringify(places), form: JSON.stringify(form) });
