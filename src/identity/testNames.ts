import { randomInt } from "node:crypto";

/** Complete words only: collision retries choose another name, never append a suffix. */
export const TEST_NAME_WORDS: readonly (readonly string[])[] = [
  "calm clear bright gentle quiet brave merry kind swift keen warm cool bold proud fair wise soft eager happy jolly noble vivid misty sandy snowy sunny wild green blue golden silver amber coral hazel".split(" "),
  "cedar maple willow birch alder aspen beech elm fir pine oak spruce ash larch laurel poplar rowan holly hazel olive acacia clover fern ivy moss reed rose sage thyme mint basil tulip iris violet".split(" "),
  "fox owl wren robin raven finch lark crane heron dove swan duck goose tern otter badger beaver marten stoat hare rabbit deer moose elk bison yak panda koala lemur gecko turtle frog toad moth".split(" "),
];

export function testUsername(pick: (limit: number) => number = randomInt): string {
  return TEST_NAME_WORDS.map(words => words[pick(words.length)]!).join("-");
}
