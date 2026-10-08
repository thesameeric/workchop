import { AsyncLocalStorage } from 'node:async_hooks';

const txScope = new AsyncLocalStorage<{ db: object; active: boolean }>();

/** Throws when `db`'s own handle is used inside one of its transactions. */
export function assertOutsideTransaction(db: object): void {
  const scope = txScope.getStore();
  if (scope?.active && scope.db === db) {
    throw new Error('Use the transaction handle (tx) inside db.transaction(), not db itself');
  }
}

/** Runs a transaction body so that `assertOutsideTransaction` can tell it apart. */
export async function inTransactionScope<T>(db: object, fn: () => Promise<T>): Promise<T> {
  const scope = { db, active: true };
  try {
    return await txScope.run(scope, fn);
  } finally {
    // Work the body started but didn't await may still run later, outside the transaction.
    scope.active = false;
  }
}
