/** A waiting ticket, as far as its place in the queue goes. */
export interface InQueue {
  id: string;
  number: number;
  createdAt: number;
  /** Set when an agent called it before (and it came back because they left): those go first. */
  assignedAt: number | null;
}

/** The queue's order: tickets that came back from an agent first, then oldest first. */
export function byTurn(a: InQueue, b: InQueue): number {
  return Number(a.assignedAt === null) - Number(b.assignedAt === null) || a.createdAt - b.createdAt || a.number - b.number;
}

/** How many tickets are ahead of each waiting ticket (customers who stepped away keep their place). */
export function positions(waiting: InQueue[]): Map<string, number> {
  return new Map([...waiting].sort(byTurn).map((t, i) => [t.id, i]));
}

/** Who Next calls: the first in the queue whose customer is here. */
export function nextUp<T extends InQueue>(waiting: T[], present: ReadonlySet<string>): T | undefined {
  return [...waiting].sort(byTurn).find((t) => present.has(t.id));
}
