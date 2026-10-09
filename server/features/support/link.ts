/** Someone in a support workspace, as the call rule sees them. */
export interface SupportParty {
  customer: boolean;
  /** For a customer, the ticket an agent is serving them on; for staff, the ticket they're serving. */
  serving: string | null;
}

/**
 * Who is in a call with whom in a support workspace (a link rule, see RealtimeApi.addLinkRule):
 * customers never with each other; a customer with the agent serving them always, wherever they
 * are, and with nobody else; an agent serving someone not with the other staff. Otherwise null:
 * distance and private areas decide.
 */
export function supportLink(a: SupportParty, b: SupportParty): boolean | null {
  if (a.customer && b.customer) return false;
  if (a.customer || b.customer) return a.serving !== null && a.serving === b.serving;
  if (a.serving || b.serving) return false;
  return null;
}
