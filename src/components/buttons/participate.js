// After Dark Entertainment - Raffle Participation

import { MessageFlags } from 'discord.js';

import {
  getGiveaway,
  addOrRemoveEntry,
  scheduleEmbedRefresh,
  endIfFirstClickComplete,
} from '../../services/giveawayService.js';

import { getSettings } from '../../services/settingsService.js';

import {
  checkEligibility,
  resolveGiveawayEligibility,
} from '../../utils/eligibility.js';

import { getRaffleTicket } from '../../utils/raffleTickets.js';
import { isFirstClick } from '../../utils/winnerMode.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../utils/i18n.js';

export default {
  prefix: 'gw:join:',

  async execute(client, interaction) {
    const guildId = interaction.guildId;
    const id = interaction.customId.split(':')[2];

    const giveaway = await getGiveaway(id, guildId);

    if (!giveaway) {
      return interaction.reply({
        content: t(guildId, 'error.not_found'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (giveaway.status === 'PAUSED') {
      return interaction.reply({
        content: t(guildId, 'error.paused'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (giveaway.status !== 'ACTIVE') {
      const key =
        isFirstClick(giveaway) && giveaway.status === 'ENDED'
          ? 'error.too_late'
          : 'error.not_active';

      return interaction.reply({
        content: t(guildId, key),
        flags: MessageFlags.Ephemeral,
      });
    }

    const settings = await getSettings(guildId);

    const member = await interaction.guild.members.fetch(
      interaction.user.id
    );

    const effective = resolveGiveawayEligibility(
      settings,
      giveaway
    );

    const elig = checkEligibility(member, effective);

    if (!elig.ok) {
      return interaction.reply({
        content: t(guildId, elig.reason, elig.vars),
        flags: MessageFlags.Ephemeral,
      });
    }

    // Verify that the participant has exactly one valid ticket.
    const ticket = getRaffleTicket(member);

    if (!ticket) {
      return interaction.reply({
        content:
          'You need exactly one valid raffle ticket to participate.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const fast = isFirstClick(giveaway);

    // Save the ticket role and its weight for this giveaway.
    const action = await addOrRemoveEntry(
      id,
      interaction.user.id,
      {
        toggle: !fast,
        ticketWeight: ticket.weight,
        ticketRoleId: ticket.roleId,
      }
    );

    const key = {
      added: 'join.success',
      removed: 'join.removed',
      already: 'join.already',
    }[action];

    if (fast) {
      const reply = interaction.reply({
        content:
          action === 'added'
            ? `You joined the raffle with your ${ticket.name} (${ticket.weight} entries)!`
            : t(guildId, key),
        flags: MessageFlags.Ephemeral,
      });

      endIfFirstClickComplete(client, giveaway)
        .then((ended) => {
          if (ended === null) {
            scheduleEmbedRefresh(client, giveaway, settings);
          }
        })
        .catch((err) => {
          logger.error(
            `endIfFirstClickComplete(${id}):`,
            err
          );
        });

      return reply;
    }

    scheduleEmbedRefresh(client, giveaway, settings);

    return interaction.reply({
      content:
        action === 'added'
          ? `You joined the raffle with your ${ticket.name} (${ticket.weight} entries)!`
          : t(guildId, key),
      flags: MessageFlags.Ephemeral,
    });
  },
};
