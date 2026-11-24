/** A bounded batch owns all its reads, including transaction cleanup. Preserve the first error, but only after they stop. */
export async function joinReads<const T extends readonly unknown[]>(reads: T) {
  try { return await Promise.all(reads); }
  catch (error) { await Promise.allSettled(reads); throw error; }
}

/** Keep discovery order without opening every record at once. Do not return while a sibling read is still active. */
export async function boundedReads<T, R>(input: readonly T[], limit: number, read: (value: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = [];
  let next = 0, stopped = false;
  async function lane() {
    while (!stopped && next < input.length) {
      signal?.throwIfAborted();
      const index = next++;
      try { results[index] = await read(input[index]!); }
      catch (error) { stopped = true; throw error; }
    }
  }
  await joinReads(Array.from({ length: Math.min(input.length, limit) }, lane));
  return results;
}
