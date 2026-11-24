import { z } from "zod";

const count = z.number().int().nonnegative();
const user = z.object({
  username: z.string().min(1), agents: z.array(z.string().min(1)), matches: count, wins: count, losses: count, own: count,
  latest: z.object({ startedAt: z.string().min(1), id: z.string().min(1) }), model: z.string().nullable(), moreModels: count,
  agentDetails: z.array(z.object({ handle: z.string(), models: z.array(z.string()), matches: count })),
  recent: z.array(z.object({ startedAt: z.string(), id: z.string(), agents: z.array(z.string()), result: z.enum(["Own match", "Won", "Lost", "Draw", "Abandoned", "No result"]), colonies: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    matchType: z.object({ kind: z.enum(["ranked", "unranked", "unrated", "index", "challenge", "quadrants"]), size: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]) }).nullable(),
    opponents: z.array(z.object({ handle: z.string().nullable(), modelLabel: z.string().nullable(), thinkingLevel: z.string().nullable(), serviceTier: z.string().nullable() })) })).max(5),
  ranked: z.object({ rating: z.number().finite(), rd: z.number().finite(), ratedMatches: count, via: z.string().min(1).optional() }).nullable(),
});
export type PublicUser = z.infer<typeof user>;
export const usersResponse = z.object({ users: z.array(user) });
