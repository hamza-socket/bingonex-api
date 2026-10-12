export type Serializer = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerializer(): Serializer {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}