/** A bounded batch owns all its reads, including transaction cleanup. Preserve the first error, but only after they stop. */
export async function joinReads<const T extends readonly unknown[]>(reads: T) {
  try { return await Promise.all(reads); }
  catch (error) { await Promise.allSettled(reads); throw error; }
}
