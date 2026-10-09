import { describe, expect, it } from 'vitest';
import { CURRENCY, DEFAULT_PRICES, FREE_SEATS, GUEST_CAPS } from '../shared/billing';
import { planPrices } from '../client/src/ui/landing/prices';

describe('landing page prices', () => {
  it('formats the default prices in naira', () => {
    const p = planPrices({ available: true, currency: CURRENCY, prices: { ...DEFAULT_PRICES }, freeSeats: FREE_SEATS, guestCaps: { ...GUEST_CAPS } });
    expect(p.team).toBe('₦7,500');
    expect(p.supportMonthly).toBe('₦15,000');
    expect(p.supportYearly).toBe('₦180,000');
  });

  it('passes the free seats and guest caps through', () => {
    const p = planPrices({ available: true, currency: CURRENCY, prices: { team: 500_000, support: 12_000_000 }, freeSeats: 5, guestCaps: { free: 2, team: 40 } });
    expect(p.freeSeats).toBe(5);
    expect(p.guestCaps).toEqual({ free: 2, team: 40 });
    expect(p.team).toBe('₦5,000');
    expect(p.supportMonthly).toBe('₦10,000');
  });

  it('rounds a yearly price that doesn’t split into whole kobo a month', () => {
    const p = planPrices({ available: true, currency: CURRENCY, prices: { team: 750_050, support: 10_000_001 }, freeSeats: FREE_SEATS, guestCaps: { ...GUEST_CAPS } });
    expect(p.team).toBe('₦7,500.50');
    expect(p.supportMonthly).toBe('₦8,333.33');
  });
});
