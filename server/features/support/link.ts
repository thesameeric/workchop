/** Someone in a support workspace, as the call rule sees them. */
export interface SupportParty {
  customer: boolean;
  /** For a customer, the ticket an agent is serving them on; for staff, the ticket they're serving. */
  serving: string | null;
  /** Staff: the ticket they're helping with (another agent's). */
  helping?: string | null;
}

/**
 * Who is in a call with whom in a support workspace (a link rule, see RealtimeApi.addLinkRule):
 * customers never with each other; a customer with the agent serving them and the colleagues helping,
 * wherever they are, and with nobody else; staff on a ticket (serving or helping) with the others on
 * that ticket and with no other staff. Otherwise null: distance and private areas decide.
 */
export function supportLink(a: SupportParty, b: SupportParty): boolean | null {
  if (a.customer && b.customer) return false;
  const ta = a.serving ?? a.helping ?? null;
  const tb = b.serving ?? b.helping ?? null;
  if (a.customer || b.customer) return ta !== null && ta === tb;
  if (ta !== null || tb !== null) return ta === tb;
  return null;
}
