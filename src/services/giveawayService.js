
// After Dark Entertainment - Giveaway service with stored raffle ticket weights.
import { MessageFlags } from 'discord.js';
import { prisma } from '../database/prisma.js';
import { logger } from '../utils/logger.js';
import { getSettings } from './settingsService.js';
import { buildGiveawayEmbed, buildEndedEmbed, buildCancelledEmbed, buildButtonRow, buildResultContent, buildRerollContent } from '../utils/embeds.js';
import { checkEligibility, resolveGiveawayEligibility } from '../utils/eligibility.js';
import { giveawayPrizes, prizesForWinner, assignPrizes, serializePrizes, normalizePrizeMode, inlinePrizes, bulletList } from '../utils/prizes.js';
import { serializeRoleArray, serializeBonusRoles } from '../utils/roles.js';
import { normalizeWinnerMode, isFirstClick } from '../utils/winnerMode.js';
import { generateGiveawayId } from '../utils/id.js';
import { publishResult } from './resultPublisher.js';
import { issueCoupons, revokeCoupons, manualCodeForWinner } from './tebexService.js';
import { removeRaffleTicket } from '../utils/raffleTickets.js';
import { drawWeightedEntries } from '../utils/weightedRaffle.js';
import { t } from '../utils/i18n.js';

export const createGiveaway = (data) => prisma.giveaway.create({ data });
export const getGiveaway = (id, guildId) => prisma.giveaway.findFirst({ where: { id, guildId } });
export const setGiveawayBlacklistRoles = (id, roles) => prisma.giveaway.update({ where: { id }, data: { blacklistRoles: JSON.stringify(roles) } });
export const setGiveawayWhitelistRoles = (id, roles) => prisma.giveaway.update({ where: { id }, data: { whitelistRoles: JSON.stringify(roles) } });
export const setGiveawayBonusRoles = (id, bonus) => prisma.giveaway.update({ where: { id }, data: { bonusRoles: JSON.stringify(bonus) } });
export const resetGiveawayEligibility = (id) => prisma.giveaway.update({ where: { id }, data: { blacklistRoles: null, whitelistRoles: null, bonusRoles: null } });
export const listActive = (guildId) => prisma.giveaway.findMany({ where: { guildId, status: 'ACTIVE' }, orderBy: { endAt: 'asc' } });
export const countEntries = (giveawayId) => prisma.entry.count({ where: { giveawayId } });

export async function getWinners(giveawayId, { onlyActive = false } = {}) {
  return prisma.winner.findMany({
    where: { giveawayId, ...(onlyActive ? { rerolled: false } : {}) },
    select: { userId: true, prizeIndex: true },
    orderBy: [{ prizeIndex: 'asc' }, { pickedAt: 'asc' }],
  });
}

export async function getWinnerIds(giveawayId, options = {}) {
  return (await getWinners(giveawayId, options)).map((w) => w.userId);
}

export async function addOrRemoveEntry(giveawayId, userId, { toggle = true, ticketWeight = 1, ticketRoleId = null } = {}) {
  if (![1, 3, 5, 7].includes(ticketWeight) || !ticketRoleId) return 'invalid_ticket';

  return prisma.$transaction(async (tx) => {
    const lockName = `ade:raffle:${userId}`;
    const lock = await tx.$queryRaw`SELECT GET_LOCK(${lockName}, 5) AS acquired`;
    if (Number(lock[0]?.acquired) !== 1) return 'busy';

    try {
      const giveaway = await tx.giveaway.findUnique({ where: { id: giveawayId } });
      if (!giveaway || giveaway.status !== 'ACTIVE') return 'not_active';

      const where = { giveawayId_userId: { giveawayId, userId } };
      const existing = await tx.entry.findUnique({ where });

      if (existing) {
        if (!toggle) return 'already';
        await tx.entry.deleteMany({ where: { giveawayId, userId } });
        return 'removed';
      }

      const other = await tx.entry.findFirst({
        where: {
          userId,
          giveawayId: { not: giveawayId },
          ticketRoleId: { not: null },
          giveaway: {
            guildId: giveaway.guildId,
            status: { in: ['ACTIVE', 'PAUSED'] },
          },
        },
      });

      if (other) return 'ticket_in_use';

      await tx.entry.create({
        data: { giveawayId, userId, ticketWeight, ticketRoleId },
      });

      return 'added';
    } finally {
      await tx.$queryRaw`SELECT RELEASE_LOCK(${lockName}) AS released`;
    }
  }, { maxWait: 10000, timeout: 15000 });
}

export const cancelGiveaway = (id, guildId) =>
  prisma.giveaway.update({
    where: { id, guildId },
    data: { status: 'CANCELLED', endedAt: new Date() },
  });

async function fetchMembers(guild, userIds) {
  let bulk;

  try {
    bulk = await guild.members.fetch({ user: userIds });
  } catch {
    bulk = null;
  }

  const members = new Map();

  for (const id of userIds) {
    let member = bulk?.get(id);

    if (!member) {
      try {
        member = await guild.members.fetch(id);
      } catch {
        continue;
      }
    }

    members.set(id, member);
  }

  return members;
}

export async function drawWinners(giveaway, guild, settings, { exclude = [] } = {}) {
  const entries = await prisma.entry.findMany({
    where: { giveawayId: giveaway.id },
  });

  const candidates = entries.filter((e) => !exclude.includes(e.userId));
  if (!candidates.length) return [];

  const members = await fetchMembers(
    guild,
    candidates.map((e) => e.userId)
  );

  const eligibility = resolveGiveawayEligibility(settings, giveaway);

  const eligible = candidates.filter((e) => {
    const member = members.get(e.userId);
    return member && checkEligibility(member, eligibility).ok;
  });

  return drawWeightedEntries(
    eligible,
    giveaway.winnersCount,
    exclude
  );
}

export async function pickFirstEntries(giveaway, guild, settings, { exclude = [] } = {}) {
  const entries = await prisma.entry.findMany({
    where: { giveawayId: giveaway.id },
    orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true },
  });

  const pool = entries
    .map((e) => e.userId)
    .filter((id) => !exclude.includes(id));

  if (!pool.length) return [];

  const members = await fetchMembers(guild, pool);
  const eligibility = resolveGiveawayEligibility(settings, giveaway);
  const winners = [];

  for (const id of pool) {
    const member = members.get(id);

    if (member && checkEligibility(member, eligibility).ok) {
      winners.push(id);
    }

    if (winners.length >= giveaway.winnersCount) break;
  }

  return winners;
}

export const selectWinners = (giveaway, guild, settings, opts = {}) =>
  isFirstClick(giveaway)
    ? pickFirstEntries(giveaway, guild, settings, opts)
    : drawWinners(giveaway, guild, settings, opts);

export async function endIfFirstClickComplete(client, giveaway) {
  if (!isFirstClick(giveaway)) return null;
  if ((await countEntries(giveaway.id)) < giveaway.winnersCount) return null;
  return endGiveaway(giveaway, client);
}

const EMBED_THROTTLE_MS = 4000;
const embedThrottle = new Map();

async function refreshActiveEmbed(client, giveaway, settings) {
  try {
    if (!giveaway.messageId) return;

    const fresh = await prisma.giveaway.findUnique({
      where: { id: giveaway.id },
    });

    if (!fresh || fresh.status !== 'ACTIVE') return;

    const channel = await client.channels.fetch(giveaway.channelId);
    const msg = await channel.messages.fetch(giveaway.messageId);
    const entryCount = await countEntries(giveaway.id);

    await msg.edit({
      embeds: [buildGiveawayEmbed(fresh, settings, { entryCount })],
      components: [buildButtonRow(fresh, settings, { disabled: false })],
    });
  } catch (err) {
    logger.warn(`refreshActiveEmbed(${giveaway.id}):`, err?.message ?? err);
  }
}

export function scheduleEmbedRefresh(client, giveaway, settings) {
  const state = embedThrottle.get(giveaway.id) ?? {
    last: 0,
    timer: null,
  };

  embedThrottle.set(giveaway.id, state);

  if (state.timer) return;

  const run = async () => {
    state.timer = null;
    state.last = Date.now();
    await refreshActiveEmbed(client, giveaway, settings);
  };

  const sinceLast = Date.now() - state.last;

  if (sinceLast >= EMBED_THROTTLE_MS) {
    void run();
  } else {
    state.timer = setTimeout(run, EMBED_THROTTLE_MS - sinceLast);
  }
}

const messageLink = (giveaway) =>
  giveaway.messageId
    ? `https://discord.com/channels/${giveaway.guildId}/${giveaway.channelId}/${giveaway.messageId}`
    : null;

export async function dmWinners(client, giveaway, settings, winners, { resultUrl = null, coupons = null } = {}) {
  if (!winners?.length) return;

  const g = giveaway.guildId;
  const guildName = client.guilds.cache.get(g)?.name ?? '';
  const link = messageLink(giveaway);
  const prizes = giveawayPrizes(giveaway);

  let tail = '';

  if (settings.claimMessage) tail += `\n${settings.claimMessage}`;
  if (link) tail += `\n${t(g, 'dm.winner_link', { link })}`;
  if (resultUrl) tail += `\n${t(g, 'result.link', { url: resultUrl })}`;

  for (const { userId, prizeIndex } of winners) {
    const own = prizesForWinner(
      prizes,
      giveaway.prizeMode,
      prizeIndex
    );

    let content = own.length > 1
      ? t(g, 'dm.winner_multi', {
          prizes: bulletList(own),
          guild: guildName,
        })
      : t(g, 'dm.winner', {
          prize: own[0] ?? giveaway.title,
          guild: guildName,
        });

    content += tail;

    const coupon = coupons?.get(userId);

    if (coupon) {
      content += `\n\n${t(g, 'dm.coupon', {
        code: coupon.code,
        percent: giveaway.couponPercent,
      })}`;

      content += coupon.expiresAt
        ? `\n${t(g, 'dm.coupon_expires', {
            date: new Date(coupon.expiresAt).toLocaleDateString('en-CA'),
          })}`
        : `\n${t(g, 'dm.coupon_forever')}`;

      if (settings.tebexStoreUrl) {
        content += `\n${t(g, 'dm.coupon_store', {
          url: settings.tebexStoreUrl,
        })}`;
      }
    }

    const manual = manualCodeForWinner(giveaway, prizeIndex);

    if (manual) {
      content += `\n\n${t(g, 'dm.coupon_manual', {
        code: manual,
      })}`;

      if (giveaway.couponManualNote) {
        content += `\n${giveaway.couponManualNote}`;
      }
    }

    try {
      const user = await client.users.fetch(userId);
      await user.send({
        content,
        flags: MessageFlags.SuppressEmbeds,
      });
    } catch {
      // DMs disabled.
    }
  }
}

async function finalizeMessages(client, giveaway, settings, winners, { resultUrl = null, coupons = null } = {}) {
  const entryCount = await countEntries(giveaway.id);

  let channel;

  try {
    channel = await client.channels.fetch(giveaway.channelId);
  } catch {
    return;
  }

  if (giveaway.messageId) {
    try {
      const msg = await channel.messages.fetch(giveaway.messageId);

      await msg.edit({
        embeds: [buildEndedEmbed(giveaway, settings, {
          winners,
          entryCount,
        })],
        components: [buildButtonRow(giveaway, settings, {
          disabled: true,
        })],
      });
    } catch (err) {
      logger.warn(
        'finalizeMessages: could not edit original:',
        err?.message ?? err
      );
    }
  }

  try {
    let content = buildResultContent(
      giveaway,
      winners,
      entryCount
    );

    if (resultUrl) {
      content += `\n${t(giveaway.guildId, 'result.link', {
        url: resultUrl,
      })}`;
    }

    await channel.send({
      content,
      allowedMentions: {
        users: winners.map((w) => w.userId),
      },
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    logger.warn(
      'finalizeMessages: could not post result:',
      err?.message ?? err
    );
  }

  await dmWinners(client, giveaway, settings, winners, {
    resultUrl,
    coupons,
  });
}

// Ticket roles are removed after the completed raffle.
// Saved entries remain available for rerolls.
async function consumeRaffleTickets(client, giveaway) {
  const entries = await prisma.entry.findMany({
    where: {
      giveawayId: giveaway.id,
      ticketRoleId: { not: null },
    },
  });

  if (!entries.length) return;

  const guild = await client.guilds
    .fetch(giveaway.guildId)
    .catch(() => null);

  if (!guild) return;

  for (const entry of entries) {
    try {
      const inOtherRaffle = await prisma.entry.findFirst({
        where: {
          userId: entry.userId,
          giveawayId: { not: giveaway.id },
          ticketRoleId: entry.ticketRoleId,
          giveaway: {
            guildId: giveaway.guildId,
            status: { in: ['ACTIVE', 'PAUSED'] },
          },
        },
      });

      if (inOtherRaffle) continue;

      const member = await guild.members
        .fetch(entry.userId)
        .catch(() => null);

      if (member?.roles.cache.has(entry.ticketRoleId)) {
        await removeRaffleTicket(member, entry.ticketRoleId);
      }
    } catch (err) {
      logger.warn(
        `consumeRaffleTickets(${giveaway.id}, ${entry.userId}):`,
        err?.message ?? err
      );
    }
  }
}

export async function endGiveaway(giveaway, client) {
  const id = giveaway.id;

  let claimed;

  try {
    claimed = await prisma.giveaway.updateMany({
      where: { id, status: 'ACTIVE' },
      data: {
        status: 'ENDED',
        endedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error(`endGiveaway(${id}): claim failed:`, err);
    return null;
  }

  if (claimed.count === 0) return null;

  try {
    const fresh = await prisma.giveaway.findUnique({
      where: { id },
    });

    if (!fresh) return null;

    const settings = await getSettings(fresh.guildId);

    const guild = await client.guilds
      .fetch(fresh.guildId)
      .catch(() => null);

    const winnerIds = guild
      ? await selectWinners(fresh, guild, settings)
      : [];

    const winners = assignPrizes(
      winnerIds,
      fresh.prizeMode
    );

    if (winners.length) {
      await prisma.winner.createMany({
        data: winners.map(({ userId, prizeIndex }) => ({
          giveawayId: id,
          userId,
          prizeIndex,
        })),
        skipDuplicates: true,
      });
    }

    await consumeRaffleTickets(client, fresh);

    const resultUrl = await publishResult(
      client,
      fresh,
      settings,
      winners
    );

    const coupons = await issueCoupons(
      settings,
      fresh,
      winners
    );

    await finalizeMessages(
      client,
      fresh,
      settings,
      winners,
      { resultUrl, coupons }
    );

    await sendGuildLog(
      client,
      settings,
      t(fresh.guildId, 'log.ended', {
        id,
        title: fresh.title,
        count: winnerIds.length,
      })
    );

    if (coupons.size) {
      await sendGuildLog(
        client,
        settings,
        t(fresh.guildId, 'log.coupons', {
          id,
          count: coupons.size,
          percent: fresh.couponPercent,
        })
      );
    }

    return winnerIds;
  } catch (err) {
    logger.error(
      `endGiveaway(${id}): failed after claim, reroll with /greroll ${id}:`,
      err
    );

    return [];
  }
}

export async function sendGuildLog(client, settings, content) {
  if (!settings?.logChannel) return;

  try {
    const ch = await client.channels.fetch(settings.logChannel);

    await ch.send({
      content,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    logger.warn(
      'sendGuildLog:',
      err?.message ?? err
    );
  }
}

export async function postGiveaway(client, channel, settings, {
  guildId,
  hostId,
  title,
  description,
  prizes = [],
  prizeMode = 'ALL',
  winnerMode = 'RANDOM',
  winnersCount,
  endAt,
  blacklistRoles,
  whitelistRoles,
  bonusRoles,
}) {
  const id = await generateGiveawayId();

  const mode = normalizePrizeMode(prizeMode);
  const prizeList = Array.isArray(prizes) ? prizes : [];

  const winners =
    mode === 'INDIVIDUAL' && prizeList.length
      ? prizeList.length
      : winnersCount;

  const reminderMin = Number(settings.reminderMinutes) || 0;

  let reminderAt = null;

  if (reminderMin > 0) {
    const r = new Date(
      endAt.getTime() - reminderMin * 60000
    );

    if (r.getTime() > Date.now()) reminderAt = r;
  }

  const giveaway = await createGiveaway({
    id,
    guildId,
    channelId: channel.id,
    hostId,
    title,
    description,
    prizes: serializePrizes(prizeList),
    prizeMode: mode,
    winnerMode: normalizeWinnerMode(winnerMode),
    winnersCount: winners,
    endAt,
    status: 'ACTIVE',
    reminderAt,
    blacklistRoles:
      blacklistRoles == null
        ? null
        : serializeRoleArray(blacklistRoles),
    whitelistRoles:
      whitelistRoles == null
        ? null
        : serializeRoleArray(whitelistRoles),
    bonusRoles:
      bonusRoles == null
        ? null
        : serializeBonusRoles(bonusRoles),
  });

  try {
    const content = settings.notifyRole
      ? `<@&${settings.notifyRole}>`
      : undefined;

    const msg = await channel.send({
      content,
      embeds: [buildGiveawayEmbed(giveaway, settings, {
        entryCount: 0,
      })],
      components: [buildButtonRow(giveaway, settings, {
        disabled: false,
      })],
      allowedMentions: {
        roles: settings.notifyRole
          ? [settings.notifyRole]
          : [],
      },
    });

    await prisma.giveaway.update({
      where: { id },
      data: { messageId: msg.id },
    });

    await sendGuildLog(
      client,
      settings,
      t(guildId, 'log.created', {
        id,
        title,
        user: `<@${hostId}>`,
      })
    );

    return id;
  } catch (err) {
    await prisma.giveaway
      .delete({ where: { id } })
      .catch(() => {});

    throw err;
  }
}

export async function editActiveMessage(client, giveaway, settings, { disabled = false, paused = false } = {}) {
  if (!giveaway.messageId) return;

  try {
    const channel = await client.channels.fetch(giveaway.channelId);
    const msg = await channel.messages.fetch(giveaway.messageId);
    const entryCount = await countEntries(giveaway.id);

    const embed = buildGiveawayEmbed(
      giveaway,
      settings,
      { entryCount }
    );

    if (paused) embed.setTitle(`⏸️ ${giveaway.title}`);

    await msg.edit({
      embeds: [embed],
      components: [buildButtonRow(giveaway, settings, {
        disabled,
      })],
    });
  } catch (err) {
    logger.warn(
      `editActiveMessage(${giveaway.id}):`,
      err?.message ?? err
    );
  }
}

export const EMBED_SETTINGS_KEYS = [
  'lang',
  'embedColor',
  'buttonEmoji',
  'buttonStyle',
  'blacklist',
  'whitelist',
  'bonusRoles',
  'minAccountDays',
  'minMemberDays',
];

export async function refreshActiveEmbeds(client, guildId, settings) {
  const rows = await prisma.giveaway.findMany({
    where: {
      guildId,
      status: { in: ['ACTIVE', 'PAUSED'] },
    },
  });

  for (const giveaway of rows) {
    await editActiveMessage(client, giveaway, settings, {
      disabled: giveaway.status !== 'ACTIVE',
      paused: giveaway.status === 'PAUSED',
    });
  }

  return rows.length;
}

export async function pauseGiveaway(client, giveaway, settings) {
  const updated = await prisma.giveaway.update({
    where: { id: giveaway.id },
    data: {
      status: 'PAUSED',
      pausedAt: new Date(),
    },
  });

  await editActiveMessage(client, updated, settings, {
    disabled: true,
    paused: true,
  });

  await sendGuildLog(
    client,
    settings,
    t(giveaway.guildId, 'log.paused', {
      id: giveaway.id,
      title: giveaway.title,
    })
  );

  return updated;
}

export async function resumeGiveaway(client, giveaway, settings) {
  const pausedMs = giveaway.pausedAt
    ? Date.now() - new Date(giveaway.pausedAt).getTime()
    : 0;

  const endAt = new Date(
    new Date(giveaway.endAt).getTime() + pausedMs
  );

  const updated = await prisma.giveaway.update({
    where: { id: giveaway.id },
    data: {
      status: 'ACTIVE',
      pausedAt: null,
      endAt,
    },
  });

  await editActiveMessage(client, updated, settings);

  await sendGuildLog(
    client,
    settings,
    t(giveaway.guildId, 'log.resumed', {
      id: giveaway.id,
      title: giveaway.title,
    })
  );

  return updated;
}

export async function replaceWinner(giveaway, guild, settings, oldUserId) {
  const current = await getWinners(giveaway.id);

  const drawn = await selectWinners(
    giveaway,
    guild,
    settings,
    { exclude: current.map((w) => w.userId) }
  );

  const newWinner = drawn[0] ?? null;

  if (!newWinner) return null;

  const prizeIndex =
    current.find((w) => w.userId === oldUserId)?.prizeIndex
    ?? null;

  await prisma.winner.updateMany({
    where: {
      giveawayId: giveaway.id,
      userId: oldUserId,
    },
    data: { rerolled: true },
  });

  await prisma.winner.upsert({
    where: {
      giveawayId_userId: {
        giveawayId: giveaway.id,
        userId: newWinner,
      },
    },
    update: {
      rerolled: false,
      prizeIndex,
    },
    create: {
      giveawayId: giveaway.id,
      userId: newWinner,
      prizeIndex,
    },
  });

  return {
    userId: newWinner,
    prizeIndex,
  };
}

export async function cancelAndFinalize(client, giveaway, settings, { actor } = {}) {
  const updated = await cancelGiveaway(
    giveaway.id,
    giveaway.guildId
  );

  if (giveaway.messageId) {
    try {
      const channel = await client.channels.fetch(giveaway.channelId);
      const msg = await channel.messages.fetch(giveaway.messageId);

      await msg.edit({
        embeds: [buildCancelledEmbed(giveaway, settings)],
        components: [buildButtonRow(giveaway, settings, {
          disabled: true,
        })],
      });
    } catch (err) {
      logger.warn(
        `cancelAndFinalize(${giveaway.id}):`,
        err?.message ?? err
      );
    }
  }

  await sendGuildLog(
    client,
    settings,
    t(giveaway.guildId, 'log.cancelled', {
      id: giveaway.id,
      title: giveaway.title,
      user: actor,
    })
  );

  return updated;
}

async function warnAboutManualCodes(client, giveaway, settings, winners) {
  const affected = winners.filter(({ prizeIndex }) =>
    manualCodeForWinner(giveaway, prizeIndex)
  );

  if (affected.length) {
    await sendGuildLog(
      client,
      settings,
      t(giveaway.guildId, 'log.coupon_manual_reroll', {
        id: giveaway.id,
        count: affected.length,
      })
    );
  }
}

export async function rerollAll(client, giveaway, settings, { actor } = {}) {
  const guild = await client.guilds
    .fetch(giveaway.guildId)
    .catch(() => null);

  const previousWinners = await getWinnerIds(giveaway.id);

  const newWinnerIds = guild
    ? await selectWinners(
        giveaway,
        guild,
        settings,
        { exclude: previousWinners }
      )
    : [];

  if (!newWinnerIds.length) return [];

  const newWinners = assignPrizes(
    newWinnerIds,
    giveaway.prizeMode
  );

  await prisma.winner.updateMany({
    where: { giveawayId: giveaway.id },
    data: { rerolled: true },
  });

  await prisma.winner.createMany({
    data: newWinners.map(({ userId, prizeIndex }) => ({
      giveawayId: giveaway.id,
      userId,
      prizeIndex,
    })),
    skipDuplicates: true,
  });

  await revokeCoupons(
    settings,
    giveaway,
    previousWinners
  );

  const coupons = await issueCoupons(
    settings,
    giveaway,
    newWinners
  );

  await warnAboutManualCodes(
    client,
    giveaway,
    settings,
    newWinners
  );

  const resultUrl = await publishResult(
    client,
    giveaway,
    settings,
    newWinners
  );

  try {
    const channel = await client.channels.fetch(giveaway.channelId);

    let content = buildRerollContent(
      giveaway,
      newWinners
    );

    if (resultUrl) {
      content += `\n${t(giveaway.guildId, 'result.link', {
        url: resultUrl,
      })}`;
    }

    await channel.send({
      content,
      allowedMentions: { users: newWinnerIds },
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    logger.warn(
      `rerollAll(${giveaway.id}):`,
      err?.message ?? err
    );
  }

  await dmWinners(
    client,
    giveaway,
    settings,
    newWinners,
    { resultUrl, coupons }
  );

  await sendGuildLog(
    client,
    settings,
    t(giveaway.guildId, 'log.rerolled', {
      id: giveaway.id,
      title: giveaway.title,
      user: actor,
    })
  );

  return newWinnerIds;
}

export async function rerollSingle(client, giveaway, settings, oldUserId, { actor } = {}) {
  const activeWinners = await getWinnerIds(
    giveaway.id,
    { onlyActive: true }
  );

  if (!activeWinners.includes(oldUserId)) {
    return { error: 'not_winner' };
  }

  const guild = await client.guilds
    .fetch(giveaway.guildId)
    .catch(() => null);

  const replacement = guild
    ? await replaceWinner(
        giveaway,
        guild,
        settings,
        oldUserId
      )
    : null;

  if (!replacement) return { error: 'no_valid' };

  const newWinner = replacement.userId;

  await revokeCoupons(
    settings,
    giveaway,
    [oldUserId]
  );

  const coupons = await issueCoupons(
    settings,
    giveaway,
    [replacement]
  );

  await warnAboutManualCodes(
    client,
    giveaway,
    settings,
    [replacement]
  );

  const resultUrl = await publishResult(
    client,
    giveaway,
    settings,
    await getWinners(giveaway.id, {
      onlyActive: true,
    })
  );

  try {
    const channel = await client.channels.fetch(giveaway.channelId);

    const own = prizesForWinner(
      giveawayPrizes(giveaway),
      giveaway.prizeMode,
      replacement.prizeIndex
    );

    const key =
      normalizePrizeMode(giveaway.prizeMode) === 'INDIVIDUAL'
      && own.length
        ? 'reroll.replaced_prize'
        : 'reroll.replaced';

    await channel.send({
      content: t(giveaway.guildId, key, {
        old: `<@${oldUserId}>`,
        new: `<@${newWinner}>`,
        title: giveaway.title,
        prize: inlinePrizes(own),
      }),
      allowedMentions: {
        users: [newWinner],
      },
    });
  } catch (err) {
    logger.warn(
      `rerollSingle(${giveaway.id}):`,
      err?.message ?? err
    );
  }

  await dmWinners(
    client,
    giveaway,
    settings,
    [replacement],
    { resultUrl, coupons }
  );

  await sendGuildLog(
    client,
    settings,
    t(giveaway.guildId, 'log.rerolled', {
      id: giveaway.id,
      title: giveaway.title,
      user: actor,
    })
  );

  return { newWinner };
}

export async function getGuildStats(guildId) {
  const [
    active,
    paused,
    ended,
    cancelled,
    entries,
    winners,
  ] = await prisma.$transaction([
    prisma.giveaway.count({
      where: { guildId, status: 'ACTIVE' },
    }),
    prisma.giveaway.count({
      where: { guildId, status: 'PAUSED' },
    }),
    prisma.giveaway.count({
      where: { guildId, status: 'ENDED' },
    }),
    prisma.giveaway.count({
      where: { guildId, status: 'CANCELLED' },
    }),
    prisma.entry.count({
      where: { giveaway: { guildId } },
    }),
    prisma.winner.count({
      where: {
        giveaway: { guildId },
        rerolled: false,
      },
    }),
  ]);

  return {
    total: active + paused + ended + cancelled,
    active,
    paused,
    ended,
    cancelled,
    entries,
    winners,
  };
}
