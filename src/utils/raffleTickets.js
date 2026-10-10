// After Dark Entertainment - Raffle Ticket System

export const RAFFLE_TICKETS = {
  '1558405655885521008': {
    name: 'Standard Ticket',
    weight: 1,
  },
  '1558406102289223690': {
    name: 'Priority Ticket',
    weight: 3,
  },
  '1558406157171953748': {
    name: 'Premium Ticket',
    weight: 5,
  },
  '1558406220208148581': {
    name: 'Deluxe Ticket',
    weight: 7,
  },
};

export function getRaffleTicket(member) {
  if (!member?.roles?.cache) return null;

  const tickets = Object.entries(RAFFLE_TICKETS)
    .filter(([roleId]) => member.roles.cache.has(roleId));

  // Each participant may hold exactly one ticket role.
  if (tickets.length !== 1) return null;

  const [roleId, ticket] = tickets[0];

  return {
    roleId,
    name: ticket.name,
    weight: ticket.weight,
  };
}

export function hasValidRaffleTicket(member) {
  return getRaffleTicket(member) !== null;
}

export async function removeRaffleTicket(member, roleId) {
  if (!member || !RAFFLE_TICKETS[roleId]) {
    return false;
  }

  if (!member.roles.cache.has(roleId)) {
    return false;
  }

  await member.roles.remove(
    roleId,
    'After Dark Entertainment - Raffle completed'
  );

  return true;
}
