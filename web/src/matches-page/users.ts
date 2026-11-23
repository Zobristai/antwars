import { z } from "zod";

const count = z.number().int().nonnegative();
const user = z.object({
  username: z.string().min(1), agents: z.array(z.string().min(1)), matches: count, wins: count, losses: count, own: count,
  latest: z.object({ startedAt: z.string().min(1), id: z.string().min(1) }), model: z.string().nullable(), moreModels: count,
  ranked: z.object({ rating: z.number().finite(), rd: z.number().finite(), ratedMatches: count }).nullable(),
});
export type PublicUser = z.infer<typeof user>;
export const usersResponse = z.object({ users: z.array(user) });
