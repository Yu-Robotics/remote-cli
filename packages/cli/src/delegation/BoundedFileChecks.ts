/** Bound filesystem work and drain the current batch before propagating failure. */
export async function checkFilesInBatches<T>(values: readonly T[], check: (value: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += 8) {
    const results = await Promise.allSettled(values.slice(offset, offset + 8).map(value =>
      Promise.resolve().then(() => check(value))));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
