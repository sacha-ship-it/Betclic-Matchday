'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  escapeMarkdown,
} = require('discord.js');

const TZ = process.env.TIMEZONE || 'Europe/Paris';
const UNIT = process.env.POINTS_LABEL || 'points';
const ICON = process.env.POINTS_EMOJI || '🏆';

const COLOR = /^#[a-f\d]{6}$/i.test(process.env.MATCHDAY_COLOR || '')
  ? process.env.MATCHDAY_COLOR
  : '#E10014';

const BASE = { 1: 2, 2: 4, 3: 8 };

const EMOJIS = {
  1: '🤙',
  2: '⚡',
  3: '🔥',
};

const NAMES = {
  1: 'Chill',
  2: 'Joueur',
  3: 'Vraiiiment joueur',
};

const EDITION = {
  title: 'BETCLIC MATCHDAY',
  description: 'Retrouve ici les prochains MatchDays.',
  blocks: {
    mardi: '',
    mercredi: '',
    jeudi: '',
    weekend: '',
  },
};

const GROUPS = {
  mardi: '⚽ MARDI',
  mercredi: '⚽ MERCREDI',
  jeudi: '⚽ JEUDI',
  weekend: '🔥 LE WEEK-END',
};

const quiet = { parse: [] };

const uid = () => randomUUID().replaceAll('-', '').slice(0, 16);
const copy = value => structuredClone(value);

const digest = value =>
  createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');

const safe = value =>
  escapeMarkdown(String(value)).replaceAll('@', '@\u200b');

class UserError extends Error {}

function need(condition, message) {
  if (!condition) throw new UserError(message);
}

function clean(value, max, label) {
  const text = String(value || '')
    .trim()
    .replace(/[\u2013\u2014]/g, '-');

  need(
    text.length > 0 && text.length <= max,
    `${label} : entre 1 et ${max} caractères.`,
  );

  return text;
}

function fixtures(text) {
  return String(text || '')
    .split(/\s+\/\s+|\r?\n|\\n/)
    .map(value => value.trim())
    .filter(Boolean);
}

function programBlocks(program) {
  return Object.entries(GROUPS).filter(
    ([key]) => fixtures(program.blocks?.[key]).length,
  );
}

function validateProgram(program) {
  dateKey(program.start);
  dateKey(program.end);

  need(
    program.start <= program.end,
    'La date de début doit précéder la date de fin.',
  );

  for (const [key] of programBlocks(program)) {
    const text = fixtures(program.blocks[key])
      .map(value => '• ' + safe(value))
      .join('\n');

    need(
      text.length <= 1000,
      `Le groupe ${key} est trop long : raccourcis les noms ou les horaires.`,
    );
  }
}

function parts(ms) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
}

function day(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateKey(value) {
  need(
    /^\d{4}-\d{2}-\d{2}$/.test(value || ''),
    'Date attendue : AAAA-MM-JJ.',
  );

  const timestamp = Date.parse(value + 'T12:00:00Z');

  need(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value,
    'Date invalide.',
  );

  return value;
}

function shift(value, days) {
  return new Date(
    Date.parse(dateKey(value) + 'T12:00:00Z') + days * 86400000,
  )
    .toISOString()
    .slice(0, 10);
}

function monday(value) {
  const weekday = new Date(
    dateKey(value) + 'T12:00:00Z',
  ).getUTCDay();

  return shift(value, -(weekday === 0 ? 6 : weekday - 1));
}

function sportDay(ms = Date.now()) {
  return Number(parts(ms).hour) < 12
    ? shift(day(ms), -1)
    : day(ms);
}

function time(ms) {
  const p = parts(ms);
  return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}`;
}

function parseTime(value) {
  let text = String(value || '').trim();

  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }

  need(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text),
    'Heure attendue : AAAA-MM-JJ HH:mm, exemple 2026-11-06 20:00.',
  );

  dateKey(text.slice(0, 10));

  const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
  const matches = [];

  for (let offset = -840; offset <= 840; offset += 15) {
    const timestamp = utc + offset * 60000;
    const p = parts(timestamp);

    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === text) {
      matches.push(timestamp);
    }
  }

  need(
    matches.length === 1,
    matches.length
      ? 'Heure ambiguë au changement d’heure. Choisis un autre horaire.'
      : 'Cette date ou cette heure n’existe pas.',
  );

  return matches[0];
}

function imageURL(value) {
  if (!value) return '';

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new UserError('URL image invalide.');
  }

  need(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      value.length <= 1000,
    'Utilise une URL image HTTPS de moins de 1 000 caractères.',
  );

  return value;
}

function odds(value) {
  const number = Number(String(value).trim().replace(',', '.'));

  need(
    Number.isFinite(number) && number >= 1 && number <= 10000,
    'Cote invalide : utilise par exemple 1,80.',
  );

  return String(value).trim();
}

const closeAt = match => Date.parse(match.closingTimeUTC);

function isOpen(match, now = Date.now()) {
  return (
    match.status === 'open' &&
    match.result === null &&
    now < closeAt(match)
  );
}

function getMatch(state, id) {
  const match = state.matches[id];

  need(
    match && match.status !== 'deleted',
    'Match introuvable. Utilise /list-matches pour retrouver son ID.',
  );

  return match;
}

function initial() {
  return {
    schema: 3,
    matches: {},
    bets: {},
    users: {},
    programs: {},
    boosts: {},
    pending: {},
    archives: [],
  };
}

function migrate(state) {
  need(
    state &&
      state.matches &&
      state.bets &&
      state.users &&
      (!state.schema || state.schema === 3),
    'Format de sauvegarde inconnu. Ne supprime pas le fichier db.json.',
  );

  state.schema = 3;
  state.programs ||= {};
  state.boosts ||= {};
  state.pending ||= {};
  state.archives ||= [];

  for (const match of Object.values(state.matches)) {
    need(
      Number.isFinite(closeAt(match)),
      `Date de fermeture invalide dans le match ${match.id}.`,
    );

    match.result =
      match.result == null
        ? null
        : Array.isArray(match.result)
          ? match.result
          : [match.result];

    match.publishAt ??= match.messageId ? 0 : Date.now();
    match.date ||= sportDay(closeAt(match));
    match.revision ||= 1;
    match.version ||= 1;
    match.description ||= '';
    match.roleId ||= null;
    match.imageUrl ||= '';
    match.imageFile ||= '';
    match.dirty = true;
    match.published ||= Boolean(match.messageId);

    for (const [id, bet] of Object.entries(state.bets[match.id] || {})) {
      bet.revision ||= match.revision;

      if (bet.boosted) {
        const key = bet.boostDay || match.date;

        state.boosts[key] ||= {};
        state.boosts[key][id] ||= match.id;
      }
    }
  }

  for (const program of Object.values(state.programs)) {
    if (!program.blocks) {
      program.blocks = Object.fromEntries(
        Object.keys(GROUPS).map(key => [key, '']),
      );

      const selected = Object.values(state.matches)
        .filter(
          match =>
            match.status !== 'deleted' &&
            match.channelId ===
              (program.matchesChannelId || program.channelId) &&
            match.date >= program.start &&
            match.date <= program.end,
        )
        .sort((a, b) => closeAt(a) - closeAt(b));

      for (const match of selected) {
        const weekday = new Date(
          match.date + 'T12:00:00Z',
        ).getUTCDay();

        const key =
          {
            2: 'mardi',
            3: 'mercredi',
            4: 'jeudi',
          }[weekday] || 'weekend';

        program.blocks[key] +=
          (program.blocks[key] ? ' / ' : '') + match.title;
      }
    }

    program.version ||= 1;
    program.dirty = true;
  }

  return state;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });

    try {
      this.state = migrate(
        JSON.parse(await fs.readFile(this.file, 'utf8')),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = initial();
    }

    await this.write(this.state);
  }

  async write(state) {
    const handle = await fs.open(this.file + '.tmp', 'w', 0o600);

    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.copyFile(this.file, this.file + '.bak');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.rename(this.file + '.tmp', this.file);
  }

  async read() {
    await this.queue;
    return copy(this.state);
  }

  change(callback) {
    const task = this.queue.then(async () => {
      const next = copy(this.state);
      const result = await callback(next);

      await this.write(next);
      this.state = next;

      return copy(result);
    });

    this.queue = task.catch(() => {});
    return task;
  }
}

function earned(match, bet) {
  return (
    match.status !== 'deleted' &&
    bet.revision === match.revision &&
    match.result?.includes(bet.choice)
  )
    ? BASE[bet.choice] * (bet.boosted ? 2 : 1)
    : 0;
}

function rank(state, range = {}) {
  const users = new Map();

  for (const match of Object.values(state.matches)) {
    if (
      match.status === 'deleted' ||
      (range.start && match.date < range.start) ||
      (range.end && match.date > range.end)
    ) {
      continue;
    }

    for (const [id, bet] of Object.entries(state.bets[match.id] || {})) {
      if (bet.revision !== match.revision) continue;

      const user = users.get(id) || {
        id,
        name: state.users[id]?.username || bet.username || id,
        points: 0,
        first: Infinity,
      };

      user.points += earned(match, bet);
      user.first = Math.min(user.first, bet.placedAt || Infinity);

      users.set(id, user);
    }
  }

  return [...users.values()]
    .filter(user => user.points > 0)
    .sort(
      (a, b) =>
        b.points - a.points ||
        a.first - b.first ||
        a.id.localeCompare(b.id),
    );
}

function boostAvailable(state, userId, now = Date.now()) {
  const key = sportDay(now);

  return (
    !state.boosts[key]?.[userId] &&
    state.users[userId]?.boostUsedToday !== key
  );
}

function place(
  state,
  matchId,
  userId,
  choice,
  boost,
  revision,
  username,
  now = Date.now(),
) {
  const match = getMatch(state, matchId);

  need(isOpen(match, now), 'Les mises sont fermées.');

  need(
    match.revision === revision && BASE[choice],
    'Ce choix a changé. Repars du message du match.',
  );

  need(
    !state.bets[matchId]?.[userId],
    'Tu as déjà participé. Ton pronostic ne peut plus être modifié.',
  );

  need(
    !boost || boostAvailable(state, userId, now),
    'Ton boost a déjà été utilisé pour cette journée.',
  );

  const key = sportDay(now);

  state.bets[matchId] ||= {};
  state.users[userId] ||= { totalPoints: 0 };

  state.bets[matchId][userId] = {
    choice,
    boosted: boost,
    revision,
    username,
    placedAt: now,
    boostDay: boost ? key : null,
    points: null,
  };

  Object.assign(state.users[userId], {
    username,
    firstBetAt: state.users[userId].firstBetAt || now,
  });

  if (boost) {
    state.boosts[key] ||= {};
    state.boosts[key][userId] = matchId;
    state.users[userId].boostUsedToday = key;
  }
}

function result(state, matchId, winners) {
  const match = getMatch(state, matchId);

  match.result = winners;
  match.status = 'closed';
  match.dirty = true;
  match.version++;

  for (const bet of Object.values(state.bets[matchId] || {})) {
    bet.points = earned(match, bet);
  }

  for (const user of Object.values(state.users)) {
    user.totalPoints = 0;
  }

  for (const user of rank(state)) {
    if (state.users[user.id]) {
      state.users[user.id].totalPoints = user.points;
    }
  }
}

function rangeOptions(options) {
  const start = options.getString('debut');
  const end = options.getString('fin');

  if (start || end) {
    need(start && end, 'Renseigne debut ET fin.');

    dateKey(start);
    dateKey(end);
    need(start <= end, 'Période invalide.');

    return {
      start,
      end,
      label: `du ${start} au ${end}`,
    };
  }

  const type = options.getString('type') || 'week';

  if (type === 'general') {
    return { label: 'général' };
  }

  if (type === 'today') {
    const current = sportDay();

    return {
      start: current,
      end: current,
      label: `du ${current}`,
    };
  }

  const current = monday(day(Date.now()));

  return {
    start: current,
    end: shift(current, 6),
    label: `du ${current} au ${shift(current, 6)}`,
  };
}

function embed(title) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setFooter({ text: 'Betclic MatchDay' });
}

function button(
  id,
  label,
  style = ButtonStyle.Secondary,
  disabled = false,
) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled);
}

function row(...buttons) {
  return new ActionRowBuilder().addComponents(buttons);
}

function media(item, targetEmbed) {
  if (item.imageFile) {
    const name = path.basename(item.imageFile);

    targetEmbed.setImage(`attachment://${name}`);

    return {
      files: [
        new AttachmentBuilder(item.imageFile, { name }),
      ],
    };
  }

  if (item.imageUrl) {
    targetEmbed.setImage(item.imageUrl);
  }

  return {};
}

function longText(targetEmbed, intro, suffix) {
  targetEmbed.setDescription(suffix || null);

  const budget = Math.min(
    4096 - suffix.length,
    6000 - targetEmbed.length,
  );

  let content = '';
  let rest = intro;

  if (intro.length > budget) {
    const required = intro.length - budget;

    need(
      required <= 1900,
      'Le message complet est trop long pour Discord : raccourcis le texte ou les autres informations.',
    );

    const paragraph = intro.lastIndexOf('\n', 1900);
    let cut = paragraph >= required ? paragraph : 1900;

    if (/^[\uDC00-\uDFFF]$/.test(intro[cut] || '')) cut--;
    if (intro[cut - 1] === '\\') cut--;

    content = intro.slice(0, cut);
    rest = intro.slice(cut);
  }

  need(
    rest.length <= budget,
    'Le message complet est trop long après mise en forme : raccourcis légèrement le texte.',
  );

  targetEmbed.setDescription(rest + suffix);

  return content;
}

function matchCard(match) {
  const open = isOpen(match);

  const targetEmbed = embed(match.title)
    .setColor(open ? COLOR : 0x7F1D1D);

  const intro = match.description ||
    'Choisis ton pronostic et tente de grimper au classement de la semaine !';

  const lines = [
    '',
    '',
    `🕒 **Fin des mises : ${time(closeAt(match))}**`,
    '',
  ];

  for (const number of [1, 2, 3]) {
    lines.push(
      `${EMOJIS[number]} **${safe(match['choice' + number + 'Label'])}**`,
      `*Cote : ${safe(match['choice' + number + 'Odds'])}* · ${ICON} **${BASE[number]} ${UNIT}**`,
      '',
    );
  }

  lines.push(
    '⚡ Un boost par journée pour doubler tes gains de points.',
    'Une fois confirmé, ton pronostic est définitif.',
  );

  if (!open) {
    lines.push(
      '',
      match.result
        ? '🔒 Résultats enregistrés.'
        : '🔒 Les mises sont fermées.',
    );
  }

  targetEmbed.setFooter({
    text: `Betclic MatchDay | Match ${match.id}`,
  });

  const content = longText(
    targetEmbed,
    intro,
    lines.join('\n'),
  );

  return {
    content,
    embeds: [targetEmbed],
    ...media(match, targetEmbed),
    components: [
      row(
        ...[1, 2, 3].map(number =>
          button(
            `md:bet:${match.id}:${number}:${match.revision}`,
            `${EMOJIS[number]} ${NAMES[number]} (+${BASE[number]} ${UNIT})`,
            [
              0,
              ButtonStyle.Secondary,
              ButtonStyle.Primary,
              ButtonStyle.Danger,
            ][number],
            !open,
          ),
        ),
        button(`md:my:${match.id}`, '📋 Mon choix'),
      ),
    ],
    allowedMentions: quiet,
  };
}

function myCard(state, match, userId) {
  const bet = state.bets[match.id]?.[userId];

  if (!bet) {
    return {
      content: 'Tu n’as pas encore validé de pronostic sur ce match.',
      embeds: [],
      components: [],
    };
  }

  const targetEmbed = embed('✅ Ton pronostic est enregistré')
    .setColor(0x22C55E)
    .setDescription(
      [
        `**${safe(match.title)}**`,
        '',
        `${EMOJIS[bet.choice]} **${safe(match['choice' + bet.choice + 'Label'])}**`,
        '',
        `${ICON} **${BASE[bet.choice] * (bet.boosted ? 2 : 1)} ${UNIT}** si ton choix est gagnant.${bet.boosted ? ' Boost x2 activé.' : ''}`,
        '',
        'Ton choix est définitif.',
        match.result
          ? `\nRésultat : **${earned(match, bet)} ${UNIT} gagnés**.`
          : '',
      ].join('\n'),
    );

  return {
    content: '',
    embeds: [targetEmbed],
    components: [],
    allowedMentions: quiet,
  };
}

function weekMatches(state, program) {
  return programBlocks(program).flatMap(([key]) =>
    fixtures(program.blocks[key]).map(title => ({
      title,
      group: key,
    })),
  );
}

function weekCard(state, program) {
  const groups = programBlocks(program);
  const custom = Boolean(
    String(program.description || '').trim(),
  );

  const intro = custom
    ? program.description
    : EDITION.description;

  const targetEmbed = embed(program.title);

  for (const [key, label] of custom ? [] : groups) {
    const date = key === 'weekend'
      ? ''
      : (() => {
          const target = {
            mardi: 2,
            mercredi: 3,
            jeudi: 4,
          }[key];

          for (
            let current = program.start;
            current <= program.end;
            current = shift(current, 1)
          ) {
            if (
              new Date(current + 'T12:00:00Z').getUTCDay() === target
            ) {
              return (
                ' ' + current.slice(8) + '/' + current.slice(5, 7)
              );
            }
          }

          return '';
        })();

    const chunks = [];
    let chunk = '';

    for (const fixture of fixtures(program.blocks[key])) {
      const line = '• ' + safe(fixture);

      if (chunk && chunk.length + line.length + 1 > 1024) {
        chunks.push(chunk);
        chunk = '';
      }

      chunk += (chunk ? '\n' : '') + line;
    }

    if (chunk) chunks.push(chunk);

    chunks.forEach((value, number) =>
      targetEmbed.addFields({
        name: label + date + (number ? ' (suite)' : ''),
        value: value + '\n\u200b',
        inline: false,
      }),
    );
  }

  if (!custom && program.rulesChannelId) {
    targetEmbed.addFields({
      name: '📋 Règlement',
      value: `<#${program.rulesChannelId}>`,
    });
  }

  const disclaimer = /freebets?/i.test(intro)
    ? ' | Freebets = crédits de jeu non retirables'
    : '';

  targetEmbed.setFooter({
    text: `Betclic MatchDay | Programme ${program.id}${disclaimer}`,
  });

  const content = longText(targetEmbed, intro, '');

  return {
    content,
    embeds: [targetEmbed],
    ...media(program, targetEmbed),
    components: [],
    allowedMentions: quiet,
  };
}

function staffCard(item, kind) {
  const fields = [
    {
      name: 'ID',
      value: `\`${item.id}\``,
    },
    {
      name: 'Statut',
      value: item.status,
      inline: true,
    },
    {
      name: 'Salon',
      value: `<#${item.channelId}>`,
      inline: true,
    },
    {
      name: 'Publication',
      value: item.publishAt
        ? time(item.publishAt)
        : 'Immédiate',
    },
  ];

  if (kind === 'matches') {
    fields.push(
      {
        name: 'Fin des mises',
        value: time(closeAt(item)),
        inline: true,
      },
      {
        name: 'Journée sportive',
        value: item.date,
        inline: true,
      },
    );
  } else {
    fields.push(
      {
        name: 'Semaine',
        value: `${item.start} au ${item.end}`,
      },
      {
        name: 'Salon des matchs',
        value: `<#${item.matchesChannelId || item.channelId}>`,
      },
    );
  }

  return {
    embeds: [
      embed(item.title)
        .addFields(fields)
        .setFooter({
          text: `Betclic MatchDay | Staff ${kind} ${item.id}`,
        }),
    ],
    allowedMentions: quiet,
  };
}

function rankCard(state, range, page = 0) {
  const all = rank(state, range);
  const pages = Math.max(1, Math.ceil(all.length / 20));

  page = Math.max(
    0,
    Math.min(Number(page) || 0, pages - 1),
  );

  const pending = Object.values(state.matches).filter(
    match =>
      match.status !== 'deleted' &&
      (!range.start || match.date >= range.start) &&
      (!range.end || match.date <= range.end) &&
      match.result === null,
  ).length;

  const description = all
    .slice(page * 20, page * 20 + 20)
    .map((user, number) => {
      const position = page * 20 + number;

      const medal = ['🥇', '🥈', '🥉'][position] ||
        `**${position + 1}.**`;

      return `${medal} <@${user.id}> | ${ICON} **${user.points} ${UNIT}**`;
    })
    .join('\n');

  const targetEmbed = embed(`🏆 Classement ${range.label}`)
    .setDescription(description || 'Aucun point pour le moment.')
    .setFooter({
      text: `Betclic MatchDay | Page ${page + 1}/${pages}`,
    });

  if (pending) {
    targetEmbed.addFields({
      name: '⏳ Classement provisoire',
      value: `${pending} résultat(s) en attente sur cette période.`,
    });
  }

  targetEmbed.addFields({
    name: 'En cas d’égalité',
    value: 'La première participation sur la période départage les membres.',
  });

  return {
    content: '',
    embeds: [targetEmbed],
    components: pages > 1
      ? [
          row(
            button(
              `md:rank:${range.start || 'all'}:${range.end || 'all'}:${page - 1}`,
              '←',
              ButtonStyle.Secondary,
              page === 0,
            ),
            button(
              `md:rank:${range.start || 'all'}:${range.end || 'all'}:${page + 1}`,
              '→',
              ButtonStyle.Secondary,
              page === pages - 1,
            ),
          ),
        ]
      : [],
    allowedMentions: quiet,
  };
}

function matchOptions(command, editing = false) {
  if (editing) {
    command.addStringOption(option =>
      option
        .setName('match_id')
        .setDescription('ID dans le salon staff ou /list-matches')
        .setRequired(true),
    );
  }

  command
    .addStringOption(option =>
      option
        .setName('titre')
        .setDescription('Titre libre du MatchDay')
        .setMaxLength(180)
        .setRequired(!editing),
    )
    .addStringOption(option =>
      option
        .setName('fermeture')
        .setDescription('Fin des mises : AAAA-MM-JJ HH:mm, heure configurée')
        .setRequired(!editing),
    );

  for (const number of [1, 2, 3]) {
    command
      .addStringOption(option =>
        option
          .setName(`choix${number}_label`)
          .setDescription(`Choix ${number} : ${BASE[number]} points`)
          .setMaxLength(180)
          .setRequired(!editing),
      )
      .addStringOption(option =>
        option
          .setName(`choix${number}_cote`)
          .setDescription(`Cote indicative du choix ${number}`)
          .setMaxLength(20)
          .setRequired(!editing),
      );
  }

  command
    .addStringOption(option =>
      option
        .setName('publication')
        .setDescription('AAAA-MM-JJ HH:mm, sinon publication immédiate'),
    )
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('Salon cible, sinon salon actuel')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(option =>
      option
        .setName('journee')
        .setDescription('Journée sportive AAAA-MM-JJ, sinon déduite du début du match'),
    )
    .addStringOption(option =>
      option
        .setName('texte')
        .setDescription('Présentation facultative, jusqu’à 5 000 caractères')
        .setMaxLength(5000),
    )
    .addStringOption(option =>
      option
        .setName('image')
        .setDescription('URL du visuel, facultatif')
        .setMaxLength(1000),
    )
    .addRoleOption(option =>
      option
        .setName('notification')
        .setDescription('Rôle à notifier à la publication, facultatif'),
    );

  if (editing) {
    command
      .addBooleanOption(option =>
        option
          .setName('retirer_image')
          .setDescription('Supprimer le visuel'),
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_notification')
          .setDescription('Retirer la notification'),
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_texte')
          .setDescription('Revenir au texte de base'),
      );
  }

  return command;
}

function programOptions(command, editing = false) {
  if (editing) {
    command.addStringOption(option =>
      option
        .setName('programme_id')
        .setDescription('ID du programme dans le salon staff')
        .setRequired(true),
    );
  }

  command
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('Salon de l’annonce, sinon salon actuel')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(option =>
      option
        .setName('publication')
        .setDescription('AAAA-MM-JJ HH:mm, heure de Paris, sinon immédiate'),
    )
    .addChannelOption(option =>
      option
        .setName('salon_matchs')
        .setDescription('Salon où les membres participent aux MatchDays')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    )
    .addStringOption(option =>
      option
        .setName('image')
        .setDescription('Lien du visuel de l’annonce')
        .setMaxLength(1000),
    )
    .addStringOption(option =>
      option
        .setName('titre')
        .setDescription('Titre libre de l’annonce, sinon BETCLIC MATCHDAY')
        .setMaxLength(180),
    )
    .addStringOption(option =>
      option
        .setName('texte')
        .setDescription('Introduction personnalisée, jusqu’à 5 000 caractères')
        .setMaxLength(5000),
    )
    .addStringOption(option =>
      option
        .setName('debut')
        .setDescription('Début AAAA-MM-JJ, sinon lundi de la semaine actuelle'),
    )
    .addStringOption(option =>
      option
        .setName('fin')
        .setDescription('Fin AAAA-MM-JJ, sinon dimanche de la semaine actuelle'),
    );

  for (const key of Object.keys(GROUPS)) {
    command.addStringOption(option =>
      option
        .setName(key)
        .setDescription(`Affiches du groupe ${key}, séparées par / ; « aucun » pour le retirer`)
        .setMaxLength(450),
    );
  }

  command
    .addRoleOption(option =>
      option
        .setName('notification')
        .setDescription('Rôle à notifier à la publication, facultatif'),
    )
    .addChannelOption(option =>
      option
        .setName('reglement')
        .setDescription('Salon du règlement, facultatif')
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ),
    );

  if (editing) {
    command
      .addBooleanOption(option =>
        option
          .setName('retirer_image')
          .setDescription('Supprimer le visuel'),
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_notification')
          .setDescription('Retirer la notification'),
      )
      .addBooleanOption(option =>
        option
          .setName('retirer_texte')
          .setDescription('Revenir au texte de base'),
      );
  }

  return command;
}

function ranges(command) {
  return command
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Semaine actuelle par défaut')
        .addChoices(
          { name: 'Semaine', value: 'week' },
          { name: 'Journée sportive', value: 'today' },
          { name: 'Général', value: 'general' },
        ),
    )
    .addStringOption(option =>
      option
        .setName('debut')
        .setDescription('Période personnalisée : AAAA-MM-JJ'),
    )
    .addStringOption(option =>
      option
        .setName('fin')
        .setDescription('Fin personnalisée : AAAA-MM-JJ'),
    );
}

function adminCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(P.Administrator);
}

function idOption(command, name = 'match_id') {
  return command.addStringOption(option =>
    option
      .setName(name)
      .setDescription('Identifiant dans la fiche staff')
      .setRequired(true),
  );
}

const commands = [
  matchOptions(
    adminCommand('create-match', 'Créer un MatchDay immédiat ou programmé'),
  ),

  matchOptions(
    adminCommand('edit-match', 'Modifier un MatchDay'),
    true,
  ),

  idOption(
    adminCommand('close-match', 'Fermer immédiatement les mises'),
  ),

  idOption(
    adminCommand('delete-match', 'Supprimer un MatchDay avec confirmation'),
  ),

  idOption(
    adminCommand('set-result', 'Enregistrer ou corriger les choix gagnants'),
  )
    .addBooleanOption(option =>
      option.setName('choix1').setDescription('Le choix 1 est gagnant'),
    )
    .addBooleanOption(option =>
      option.setName('choix2').setDescription('Le choix 2 est gagnant'),
    )
    .addBooleanOption(option =>
      option.setName('choix3').setDescription('Le choix 3 est gagnant'),
    )
    .addBooleanOption(option =>
      option.setName('annule').setDescription('Annuler le match : aucun point'),
    ),

  programOptions(
    adminCommand('schedule-week', 'Créer l’annonce du programme de la semaine'),
  ),

  programOptions(
    adminCommand('edit-week', 'Modifier l’annonce de la semaine'),
    true,
  ),

  idOption(
    adminCommand('delete-week', 'Supprimer un programme avec confirmation'),
    'programme_id',
  ),

  ranges(
    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Afficher le classement sur demande'),
  ).addBooleanOption(option =>
    option.setName('prive').setDescription('Afficher uniquement pour toi'),
  ),

  adminCommand(
    'list-matches',
    'Lister les MatchDays et les programmes',
  ).addStringOption(option =>
    option
      .setName('semaine')
      .setDescription('Filtrer sur une date AAAA-MM-JJ de la semaine'),
  ),

  ranges(
    adminCommand('export', 'Exporter les pronostics et le classement en CSV'),
  ),

  adminCommand(
    'reset-scores',
    'Archiver et remettre à zéro tous les matchs et points, avec confirmation',
  ),

  adminCommand(
    'diagnostic',
    'Vérifier la sauvegarde et les programmations',
  ),
];

async function cacheImage(item, dir) {
  item.imageFile = '';

  if (!item.imageUrl) return;

  const url = new URL(item.imageUrl);

  if (
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
  ) {
    return;
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  need(
    response.ok,
    'Lien Discord expiré ou inaccessible. Recopie le lien de l’image.',
  );

  const extension = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[response.headers.get('content-type')?.split(';')[0]];

  need(extension, 'Image attendue : PNG, JPG, WEBP ou GIF.');

  need(
    Number(response.headers.get('content-length') || 0) <= 8 * 1024 * 1024,
    'Image trop lourde : 8 Mo maximum.',
  );

  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;

    need(size <= 8 * 1024 * 1024, 'Image trop lourde : 8 Mo maximum.');

    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const folder = path.join(dir, 'images');

  await fs.mkdir(folder, { recursive: true });

  item.imageFile = path.join(
    folder,
    `${item.id}-${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}${extension}`,
  );

  await fs.writeFile(item.imageFile, buffer, { mode: 0o600 });
}

async function run() {
  const env = process.env;
  const guildId = env.DISCORD_GUILD_ID?.trim();
  const staffId = env.DISCORD_ADMIN_CHANNEL_ID?.trim();

  need(
    env.DISCORD_TOKEN && /^\d{17,20}$/.test(guildId || ''),
    'Renseigne DISCORD_TOKEN et DISCORD_GUILD_ID.',
  );

  need(
    !staffId || /^\d{17,20}$/.test(staffId),
    'DISCORD_ADMIN_CHANNEL_ID invalide.',
  );

  parts(Date.now());

  const dir = env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    './data';

  if (env.RAILWAY_ENVIRONMENT_ID) {
    need(
      env.RAILWAY_VOLUME_MOUNT_PATH &&
        path.resolve(dir) === path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH),
      'Attache le volume et fais correspondre DATA_DIR à son chemin.',
    );
  }

  const store = new Store(dir);
  await store.init();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  let ticking = false;
  let stopping = false;
  let timer;

  function admin(interaction) {
    need(
      interaction.memberPermissions?.has(P.Administrator),
      'Cette commande est réservée aux administrateurs.',
    );
  }

  function log(label, error) {
    const message = String(error?.message || 'Erreur sans détail')
      .replaceAll(env.DISCORD_TOKEN, '[TOKEN MASQUÉ]');

    console.error(
      `${label}: ${error?.code || error?.name || 'Erreur'} | ${message.slice(0, 1500)}`,
    );
  }

  async function channel(id) {
    const target = await client.channels.fetch(id);

    need(
      target &&
        target.guildId === guildId &&
        [
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ].includes(target.type),
      'Salon inaccessible ou sur un autre serveur.',
    );

    need(
      target.permissionsFor(client.user)?.has([
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
        P.AttachFiles,
        P.ReadMessageHistory,
      ]),
      'Il manque au bot une permission : voir le salon, envoyer, intégrer des liens, joindre des fichiers ou lire l’historique.',
    );

    return target;
  }

  async function fetchMessage(targetChannel, id) {
    try {
      return await targetChannel.messages.fetch(id);
    } catch (error) {
      if (error.code !== 10008) throw error;
      return null;
    }
  }

  async function findMessage(targetChannel, marker, since) {
    if (!since) return null;

    let before;

    for (let number = 0; number < 100; number++) {
      const list = await targetChannel.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!list.size) return null;

      const found = list.find(
        message =>
          message.author.id === client.user.id &&
          message.embeds.some(targetEmbed =>
            targetEmbed.footer?.text?.startsWith(marker),
          ),
      );

      if (found) return found;

      const last = list.last();

      if (last.createdTimestamp < since - 10000) return null;

      before = last.id;
    }

    throw new Error(
      'Historique trop long pour vérifier un envoi interrompu.',
    );
  }

  async function syncStaff(item, kind) {
    if (!staffId) return;

    const payload = staffCard(item, kind);
    const hash = digest(payload.embeds.map(value => value.toJSON()));

    if (
      item.staffHash === hash &&
      item.staffChannelId === staffId
    ) {
      return;
    }

    const targetChannel = await channel(staffId);

    let previous =
      item.staffChannelId === staffId && item.staffMessageId
        ? await fetchMessage(targetChannel, item.staffMessageId)
        : null;

    if (!previous && item.staffSendingAt) {
      previous = await findMessage(
        targetChannel,
        `Betclic MatchDay | Staff ${kind} ${item.id}`,
        item.staffSendingAt,
      );
    }

    if (!previous && !item.staffSendingAt) {
      await store.change(state => {
        state[kind][item.id].staffSendingAt = Date.now();
      });
    }

    const message = previous
      ? await previous.edit(payload)
      : await targetChannel.send({
          ...payload,
          nonce: BigInt(
            '0x' + digest(`staff:${kind}:${item.id}`).slice(0, 16),
          ).toString(),
          enforceNonce: true,
        });

    await store.change(state => {
      Object.assign(state[kind][item.id], {
        staffMessageId: message.id,
        staffChannelId: staffId,
        staffHash: hash,
      });
    });
  }

  async function publish(item, kind, state) {
    const isWeek = kind === 'programs';

    if (item.status === 'deleted') {
      if (item.messageId) {
        const targetChannel = await channel(
          item.postChannelId || item.channelId,
        );

        const message = await fetchMessage(
          targetChannel,
          item.messageId,
        );

        if (message) await message.delete();

        await store.change(database => {
          database[kind][item.id].messageId = null;
        });
      }

      return;
    }

    if (!item.published && item.publishAt > Date.now()) return;

    if (
      !isWeek &&
      !item.published &&
      closeAt(item) <= Date.now()
    ) {
      if (!item.missed) {
        await store.change(database => {
          database.matches[item.id].missed = true;
          database.matches[item.id].status = 'closed';
          database.matches[item.id].version++;
        });

        log(
          `Publication manquée ${item.id}`,
          new Error('Le match est déjà commencé. Il n’a pas été publié.'),
        );
      }

      return;
    }

    const payload = isWeek
      ? weekCard(state, item)
      : matchCard({
          ...item,
          status: item.status === 'scheduled' ? 'open' : item.status,
        });

    const hash = digest({
      content: payload.content || '',
      embeds: payload.embeds.map(value => value.toJSON()),
      components: payload.components.map(value => value.toJSON()),
      image: item.imageUrl,
      file: item.imageFile,
    });

    if (
      item.published &&
      item.publicHash === hash &&
      !item.dirty
    ) {
      return;
    }

    if (
      item.messageId &&
      item.postChannelId &&
      item.postChannelId !== item.channelId
    ) {
      const oldChannel = await channel(item.postChannelId);
      const oldMessage = await fetchMessage(
        oldChannel,
        item.messageId,
      );

      if (oldMessage) await oldMessage.delete();

      await store.change(database => {
        const latest = database[kind][item.id];
        latest.messageId = null;
        latest.sendingAt = null;
      });

      item.messageId = null;
      item.sendingAt = null;
    }

    const targetChannel = await channel(item.channelId);

    let previous = item.messageId
      ? await fetchMessage(targetChannel, item.messageId)
      : null;

    if (!previous && !item.messageId && item.sendingAt) {
      previous = await findMessage(
        targetChannel,
        isWeek
          ? `Betclic MatchDay | Programme ${item.id} |`
          : `Betclic MatchDay | Match ${item.id}`,
        item.sendingAt,
      );
    }

    if (!previous && !item.sendingAt) {
      item.sendingAt = Date.now();

      await store.change(database => {
        database[kind][item.id].sendingAt = item.sendingAt;
      });
    }

    const notify = !item.published && item.roleId;

    const message = previous
      ? await previous.edit({
          ...payload,
          attachments: [],
          content: payload.content || '',
          allowedMentions: quiet,
        })
      : await targetChannel.send({
          ...payload,
          content: [
            notify ? `<@&${item.roleId}>` : '',
            payload.content || '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          allowedMentions: notify
            ? { parse: [], roles: [item.roleId] }
            : quiet,
          nonce: BigInt(
            '0x' +
              digest(`${kind}:${item.id}:${item.sendingAt}`).slice(0, 16),
          ).toString(),
          enforceNonce: true,
        });

    const remove = await store.change(database => {
      const latest = database[kind][item.id];

      latest.messageId = message.id;
      latest.postChannelId = item.channelId;

      if (latest.status === 'deleted') return true;

      latest.published = true;

      if (latest.version === item.version) {
        latest.publicHash = hash;
        latest.dirty = false;

        if (latest.status === 'scheduled') {
          latest.status = 'open';
        }
      }

      return false;
    });

    if (remove) {
      await message.delete();

      await store.change(database => {
        database[kind][item.id].messageId = null;
      });
    }
  }

  async function tick() {
    if (ticking || stopping || !client.isReady()) return;

    ticking = true;

    try {
      const current = await store.read();

      if (
        Object.values(current.matches).some(
          match =>
            match.status === 'open' &&
            closeAt(match) <= Date.now(),
        )
      ) {
        await store.change(state => {
          for (const match of Object.values(state.matches)) {
            if (
              match.status === 'open' &&
              closeAt(match) <= Date.now()
            ) {
              match.status = 'closed';
              match.dirty = true;
              match.version++;
            }
          }
        });
      }

      const state = await store.read();

      for (const kind of ['programs', 'matches']) {
        const items = Object.values(state[kind]).sort(
          (a, b) => a.publishAt - b.publishAt,
        );

        for (const item of items) {
          try {
            await syncStaff(item, kind);
          } catch (error) {
            log(`Fiche staff ${item.id}`, error);
          }

          try {
            await publish(item, kind, state);
          } catch (error) {
            log(`Publication ${item.id}`, error);
          }
        }
      }
    } catch (error) {
      log('Programmation', error);
    } finally {
      ticking = false;
    }
  }

  async function ask(interaction, data) {
    const token = uid();

    await store.change(state => {
      state.pending[token] = {
        ...data,
        uid: interaction.user.id,
        expires: Date.now() + 900000,
      };
    });

    const content = data.kind === 'reset'
      ? '⚠️ Archiver tous les matchs, programmes, points et boosts, puis repartir de zéro ?'
      : data.table === 'programs'
        ? '⚠️ Supprimer cette annonce ? Les matchs et les pronostics seront conservés.'
        : '⚠️ Supprimer ce MatchDay ? Ses points seront retirés des classements. Une copie sera archivée.';

    return interaction.editReply({
      content,
      embeds: [],
      components: [
        row(
          button(
            `md:yes:${token}`,
            'Confirmer',
            ButtonStyle.Danger,
          ),
          button(`md:no:${token}`, 'Annuler'),
        ),
      ],
    });
  }

  async function slash(interaction) {
    need(
      interaction.guildId === guildId,
      'Utilise cette commande sur le serveur configuré.',
    );

    const name = interaction.commandName;

    if (name !== 'classement') admin(interaction);

    await interaction.deferReply({
      flags:
        name === 'classement' &&
        !interaction.options.getBoolean('prive')
          ? undefined
          : MessageFlags.Ephemeral,
    });

    if (name === 'create-match' || name === 'edit-match') {
      const options = interaction.options;
      const editing = name === 'edit-match';
      const state = await store.read();

      const old = editing
        ? getMatch(state, options.getString('match_id'))
        : null;

      const match = old
        ? copy(old)
        : {
            id: 'match_' + uid(),
            status: 'scheduled',
            published: false,
            result: null,
            revision: 1,
            version: 1,
            createdAt: Date.now(),
            publishAt: Date.now(),
            imageUrl: '',
            imageFile: '',
            description: '',
            roleId: null,
            messageId: null,
          };

      if (options.getString('titre') !== null) {
        match.title = clean(
          options.getString('titre'),
          180,
          'Titre',
        );
      }

      if (options.getString('fermeture')) {
        match.closingTimeUTC = new Date(
          parseTime(options.getString('fermeture')),
        ).toISOString();
      }

      for (const number of [1, 2, 3]) {
        if (options.getString(`choix${number}_label`) !== null) {
          match[`choice${number}Label`] = clean(
            options.getString(`choix${number}_label`),
            180,
            'Choix',
          );
        }

        if (options.getString(`choix${number}_cote`) !== null) {
          match[`choice${number}Odds`] = odds(
            options.getString(`choix${number}_cote`),
          );
        }
      }

      if (options.getString('publication')) {
        need(
          !old?.published,
          'Le match est déjà publié : son horaire de publication ne peut plus être changé.',
        );

        match.publishAt = parseTime(
          options.getString('publication'),
        );
      }

      if (options.getChannel('channel')) {
        match.channelId = options.getChannel('channel').id;
      }

      match.channelId ||= interaction.channelId;

      match.date = options.getString('journee')
        ? dateKey(options.getString('journee'))
        : old?.date || sportDay(closeAt(match));

      if (options.getString('texte') !== null) {
        match.description = options.getString('texte');
      }

      if (options.getString('image') !== null) {
        match.imageUrl = imageURL(options.getString('image'));
      }

      if (options.getRole('notification')) {
        match.roleId = options.getRole('notification').id;
      }

      if (editing && options.getBoolean('retirer_image')) {
        match.imageUrl = '';
        match.imageFile = '';
      }

      if (editing && options.getBoolean('retirer_notification')) {
        match.roleId = null;
      }

      if (editing && options.getBoolean('retirer_texte')) {
        match.description = '';
      }

      need(
        match.publishAt < closeAt(match),
        'La publication doit précéder la fin des mises.',
      );

      if (!old?.published) {
        need(
          closeAt(match) > Date.now() &&
            (
              !options.getString('publication') ||
              match.publishAt > Date.now()
            ),
          'Choisis des dates futures.',
        );
      }

      if (
        old &&
        (
          old.status === 'closed' ||
          closeAt(old) <= Date.now()
        )
      ) {
        need(
          closeAt(match) <= closeAt(old),
          'Un match clôturé ne peut pas être rouvert.',
        );

        match.status = 'closed';
      }

      const changedChoices = old &&
        [1, 2, 3].some(
          number =>
            match[`choice${number}Label`] !== old[`choice${number}Label`] ||
            match[`choice${number}Odds`] !== old[`choice${number}Odds`],
        );

      const sensitive = changedChoices ||
        (old && match.date !== old.date);

      matchCard(match);

      await channel(match.channelId);

      if (!old || match.imageUrl !== old.imageUrl) {
        await cacheImage(match, store.dir);
      }

      await store.change(state => {
        if (old) {
          const latest = getMatch(state, match.id);

          need(
            latest.version === old.version,
            'Le match a changé. Recommence.',
          );

          need(
            !sensitive ||
              !Object.keys(state.bets[match.id] || {}).length,
            'Des pronostics existent : les choix, cotes et la journée ne peuvent plus être remplacés.',
          );

          Object.assign(match, {
            published: latest.published,
            status:
              latest.status === 'scheduled' &&
              match.status === 'closed'
                ? 'closed'
                : latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });

          if (sensitive) match.revision++;
        }

        match.version++;
        match.dirty = true;

        state.matches[match.id] = match;
        state.bets[match.id] ||= {};
      });

      void tick();

      return interaction.editReply(
        `✅ MatchDay ${editing ? 'modifié' : 'créé'}.\n` +
        `ID : \`${match.id}\`\n` +
        `Publication : ${time(match.publishAt)}\n` +
        `Fin des mises : ${time(closeAt(match))}\n` +
        `Journée sportive : ${match.date}\n` +
        `Salon : <#${match.channelId}>`,
      );
    }

    if (name === 'schedule-week' || name === 'edit-week') {
      const options = interaction.options;
      const editing = name === 'edit-week';
      const state = await store.read();

      const old = editing
        ? state.programs[options.getString('programme_id')]
        : null;

      need(
        !editing || (old && old.status !== 'deleted'),
        'Programme introuvable.',
      );

      const program = old
        ? copy(old)
        : {
            id: 'week_' + uid(),
            status: 'scheduled',
            published: false,
            version: 1,
            publishAt: Date.now(),
            imageUrl: '',
            imageFile: '',
            description: '',
            customText: false,
            title: EDITION.title,
            start: monday(day(Date.now())),
            end: shift(monday(day(Date.now())), 6),
            blocks: copy(EDITION.blocks),
            roleId: null,
            messageId: null,
          };

      if (options.getString('titre') !== null) {
        program.title = clean(
          options.getString('titre'),
          180,
          'Titre',
        );
      }

      if (options.getString('debut')) {
        program.start = dateKey(options.getString('debut'));
      }

      if (options.getString('fin')) {
        program.end = dateKey(options.getString('fin'));
      }

      need(
        Date.parse(program.end + 'T12:00:00Z') -
          Date.parse(program.start + 'T12:00:00Z') <=
          6 * 86400000,
        'Le programme doit tenir sur sept jours maximum.',
      );

      for (const key of Object.keys(GROUPS)) {
        if (options.getString(key) !== null) {
          const text = options.getString(key)
            .trim()
            .replace(/[\u2013\u2014]/g, '-');

          program.blocks[key] = /^aucun$/i.test(text)
            ? ''
            : text;
        }
      }

      if (options.getChannel('reglement')) {
        program.rulesChannelId =
          options.getChannel('reglement').id;
      }

      validateProgram(program);

      if (options.getString('publication')) {
        need(
          !old?.published,
          'L’annonce est déjà publiée : modifie son contenu directement avec cette commande.',
        );

        program.publishAt = parseTime(
          options.getString('publication'),
        );

        need(
          program.publishAt > Date.now(),
          'Choisis une publication future.',
        );
      }

      if (options.getChannel('channel')) {
        program.channelId = options.getChannel('channel').id;
      }

      program.channelId ||= interaction.channelId;

      if (options.getChannel('salon_matchs')) {
        program.matchesChannelId =
          options.getChannel('salon_matchs').id;
      }

      program.matchesChannelId ||= program.channelId;

      if (options.getString('texte') !== null) {
        program.description = options.getString('texte');
        program.customText = Boolean(program.description.trim());
      }

      if (options.getString('image') !== null) {
        program.imageUrl = imageURL(options.getString('image'));
      }

      if (options.getRole('notification')) {
        program.roleId = options.getRole('notification').id;
      }

      if (editing && options.getBoolean('retirer_image')) {
        program.imageUrl = '';
        program.imageFile = '';
      }

      if (editing && options.getBoolean('retirer_notification')) {
        program.roleId = null;
      }

      if (editing && options.getBoolean('retirer_texte')) {
        program.description = '';
        program.customText = false;
      }

      const preview = weekCard(state, program);

      need(
        preview.embeds[0].length <= 6000,
        'Le programme est trop long pour Discord : raccourcis le texte ou les affiches.',
      );

      await channel(program.channelId);
      await channel(program.matchesChannelId);

      if (!old || program.imageUrl !== old.imageUrl) {
        await cacheImage(program, store.dir);
      }

      await store.change(state => {
        if (old) {
          const latest = state.programs[program.id];

          need(
            latest.version === old.version,
            'Le programme a changé. Recommence.',
          );

          Object.assign(program, {
            published: latest.published,
            status: latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });
        }

        program.version++;
        program.dirty = true;

        state.programs[program.id] = program;
      });

      void tick();

      return interaction.editReply(
        `✅ Programme ${editing ? 'modifié' : 'créé'}.\n` +
        `ID : \`${program.id}\`\n` +
        `Du ${program.start} au ${program.end}\n` +
        `Publication : ${time(program.publishAt)}\n` +
        `Salon : <#${program.channelId}>\n` +
        `${programBlocks(program).length} rendez-vous et ` +
        `${weekMatches(state, program).length} affiches, indépendants des paris.\n` +
        'Pour modifier les affiches : /edit-week.',
      );
    }

    const state = await store.read();

    if (name === 'close-match') {
      const id = interaction.options.getString('match_id');

      await store.change(state => {
        const match = getMatch(state, id);

        need(
          match.published,
          'Ce match est programmé : utilise /delete-match pour annuler sa publication.',
        );

        match.status = 'closed';
        match.version++;
        match.dirty = true;
      });

      void tick();

      return interaction.editReply(
        '🔒 Mises fermées. Les pronostics sont conservés.',
      );
    }

    if (name === 'set-result') {
      const id = interaction.options.getString('match_id');

      const winners = [1, 2, 3].filter(
        number => interaction.options.getBoolean(`choix${number}`),
      );

      need(
        interaction.options.getBoolean('annule') || winners.length,
        'Sélectionne les choix gagnants ou annule:true si aucun choix ne gagne.',
      );

      need(
        !interaction.options.getBoolean('annule') || !winners.length,
        'Un match annulé ne peut pas avoir de choix gagnant.',
      );

      await store.change(state => {
        const match = getMatch(state, id);

        need(match.published, 'Ce match n’a pas été publié.');

        need(
          Date.now() >= closeAt(match),
          'Attends la fin des mises avant de saisir un résultat.',
        );

        result(state, id, winners);
      });

      void tick();

      return interaction.editReply(
        '✅ Résultat enregistré. Les points sont recalculés sans doublon, même en cas de correction.',
      );
    }

    if (name === 'delete-match' || name === 'delete-week') {
      const table = name === 'delete-match'
        ? 'matches'
        : 'programs';

      const id = interaction.options.getString(
        table === 'matches' ? 'match_id' : 'programme_id',
      );

      const item = state[table][id];

      need(
        item && item.status !== 'deleted',
        'Élément introuvable.',
      );

      return ask(interaction, {
        kind: 'delete',
        table,
        id,
        version: item.version,
      });
    }

    if (name === 'reset-scores') {
      return ask(interaction, {
        kind: 'reset',
        fingerprint: digest({
          matches: state.matches,
          bets: state.bets,
          programs: state.programs,
        }),
      });
    }

    if (name === 'classement') {
      return interaction.editReply(
        rankCard(state, rangeOptions(interaction.options)),
      );
    }

    if (name === 'list-matches') {
      const date = interaction.options.getString('semaine');
      const start = date ? monday(dateKey(date)) : null;

      const items = Object.values(state.matches)
        .filter(
          match =>
            match.status !== 'deleted' &&
            (
              !start ||
              (
                match.date >= start &&
                match.date <= shift(start, 6)
              )
            ),
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) ||
            closeAt(a) - closeAt(b),
        );

      const lines = items.map(
        match =>
          `${match.date} | ${match.title} | ${match.status}\n` +
          `ID: ${match.id}\n` +
          `Publication: ${time(match.publishAt)} | ` +
          `Fermeture: ${time(closeAt(match))}\n`,
      );

      lines.push(
        '\nPROGRAMMES\n',
        ...Object.values(state.programs)
          .filter(program => program.status !== 'deleted')
          .map(
            program =>
              `${program.start} au ${program.end} | ${program.title}\n` +
              `ID: ${program.id}\n`,
          ),
      );

      return interaction.editReply({
        content:
          `${items.length} MatchDay(s). ` +
          'Les IDs sont aussi disponibles dans le salon staff si configuré.',
        files: [
          new AttachmentBuilder(
            Buffer.from(lines.join('\n') || 'Aucun match'),
            { name: 'matchdays.txt' },
          ),
        ],
      });
    }

    if (name === 'diagnostic') {
      return interaction.editReply(
        `✅ Stockage : ${store.file}\n` +
        `🕒 Fuseau : ${TZ}\n` +
        `⚡ Journée du boost : de midi à midi (${TZ})\n` +
        `📅 ${
          Object.values(state.matches).filter(
            match =>
              !match.published &&
              match.status !== 'deleted' &&
              !match.missed,
          ).length
        } matchs à publier\n` +
        `📣 ${
          Object.values(state.programs).filter(
            program =>
              !program.published &&
              program.status !== 'deleted',
          ).length
        } programmes à publier\n` +
        `🏆 Aucun classement automatique\n` +
        `${ICON} Unité : ${UNIT}`,
      );
    }

    if (name === 'export') {
      const range = rangeOptions(interaction.options);
      const values = rank(state, range);

      const rows = [
        [
          'match_id',
          'journee',
          'titre',
          'discord_id',
          'pseudo',
          'choix',
          'boost',
          'points',
          'resultat',
        ],
      ];

      for (const match of Object.values(state.matches)) {
        if (
          match.status === 'deleted' ||
          (range.start && match.date < range.start) ||
          (range.end && match.date > range.end)
        ) {
          continue;
        }

        for (
          const [id, bet] of Object.entries(state.bets[match.id] || {})
        ) {
          if (bet.revision !== match.revision) continue;

          rows.push([
            match.id,
            match.date,
            match.title,
            id,
            bet.username,
            match[`choice${bet.choice}Label`],
            bet.boosted ? 'oui' : 'non',
            earned(match, bet),
            match.result === null
              ? 'en attente'
              : match.result.join(',') || 'annulé',
          ]);
        }
      }

      const csv = value =>
        `"${String(value ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const file = (data, name) =>
        new AttachmentBuilder(
          Buffer.from(
            '\uFEFF' +
            data
              .map(line => line.map(csv).join(';'))
              .join('\r\n'),
          ),
          { name },
        );

      return interaction.editReply({
        content: `Export ${range.label}`,
        files: [
          file(rows, 'pronostics.csv'),
          file(
            [
              ['rang', 'discord_id', 'pseudo', 'points'],
              ...values.map((user, number) => [
                number + 1,
                user.id,
                user.name,
                user.points,
              ]),
            ],
            'classement.csv',
          ),
        ],
      });
    }
  }

  async function buttons(interaction) {
    need(
      interaction.guildId === guildId,
      'Serveur invalide.',
    );

    const privateMessage = interaction.message.flags.has(
      MessageFlags.Ephemeral,
    );

    if (privateMessage) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    }

    let [
      ,
      action,
      matchId,
      value,
      revision,
      finalRevision,
    ] = interaction.customId.split(':');

    // Compatibilité avec les anciens boutons.
    if (interaction.customId.startsWith('bet_')) {
      const values = interaction.customId.split('_');
      action = 'bet';
      value = values.pop();
      matchId = values.slice(1).join('_');
    }

    if (interaction.customId.startsWith('confirm_')) {
      const values = interaction.customId.split('_');
      action = 'confirm';
      revision = values.pop();
      value = values.pop();
      matchId = values.slice(1).join('_');
    }

    if (interaction.customId === 'cancel_bet') {
      action = 'cancel';
    }

    if (action === 'cancel') {
      return interaction.editReply({
        content: 'Choix annulé.',
        embeds: [],
        components: [],
      });
    }

    if (action === 'yes' || action === 'no') {
      admin(interaction);

      await store.change(state => {
        const pending = state.pending[matchId];

        need(
          pending &&
            pending.uid === interaction.user.id &&
            pending.expires > Date.now(),
          'Confirmation expirée. Recommence.',
        );

        if (action === 'yes') {
          if (pending.kind === 'reset') {
            need(
              pending.fingerprint === digest({
                matches: state.matches,
                bets: state.bets,
                programs: state.programs,
              }),
              'Des données ont changé. Relance /reset-scores.',
            );

            state.archives.push({
              at: Date.now(),
              kind: 'reset',
              matches: copy(state.matches),
              bets: copy(state.bets),
              users: copy(state.users),
              programs: copy(state.programs),
              boosts: copy(state.boosts),
            });

            for (const table of ['matches', 'programs']) {
              for (const item of Object.values(state[table])) {
                item.status = 'deleted';
                item.version++;
              }
            }

            state.users = {};
            state.bets = {};
            state.boosts = {};
          } else {
            const item = state[pending.table][pending.id];

            need(
              item && item.version === pending.version,
              'Cet élément a changé. Recommence.',
            );

            state.archives.push({
              at: Date.now(),
              kind: 'delete',
              table: pending.table,
              data: copy(item),
              bets: pending.table === 'matches'
                ? copy(state.bets[item.id] || {})
                : undefined,
            });

            item.status = 'deleted';
            item.version++;
            item.dirty = true;

            for (const user of Object.values(state.users)) {
              user.totalPoints = 0;
            }

            for (const user of rank(state)) {
              if (state.users[user.id]) {
                state.users[user.id].totalPoints = user.points;
              }
            }
          }
        }

        delete state.pending[matchId];
      });

      void tick();

      return interaction.editReply({
        content: action === 'yes'
          ? '✅ Opération confirmée.'
          : 'Opération annulée.',
        embeds: [],
        components: [],
      });
    }

    const state = await store.read();

    if (action === 'week') {
      const program = state.programs[matchId];

      need(
        program &&
          program.published &&
          program.status !== 'deleted',
        'Programme indisponible.',
      );

      return interaction.editReply(
        weekCard(state, program),
      );
    }

    if (action === 'rank') {
      const range = matchId === 'all'
        ? { label: 'général' }
        : {
            start: matchId,
            end: value,
            label: `du ${matchId} au ${value}`,
          };

      return interaction.editReply(
        rankCard(state, range, revision),
      );
    }

    const match = getMatch(state, matchId);

    if (action === 'my') {
      return interaction.editReply(
        myCard(state, match, interaction.user.id),
      );
    }

    if (state.bets[matchId]?.[interaction.user.id]) {
      return interaction.editReply({
        content:
          '✅ Ton pronostic est déjà enregistré. ' +
          'Pour le consulter, appuie sur « 📋 Mon choix ».',
        embeds: [],
        components: [],
        allowedMentions: quiet,
      });
    }

    need(isOpen(match), 'Les mises sont fermées.');

    const number = Number(value);

    need(BASE[number], 'Choix invalide.');

    if (action === 'bet') {
      need(
        !revision || Number(revision) === match.revision,
        'Le match a changé. Utilise son message actualisé.',
      );

      const boost = boostAvailable(
        state,
        interaction.user.id,
      );

      const targetEmbed = embed('Confirme ton pronostic')
        .setDescription(
          [
            `**${safe(match.title)}**`,
            '',
            `${EMOJIS[number]} **${safe(match['choice' + number + 'Label'])}**`,
            '',
            `${ICON} **${BASE[number]} ${UNIT}** si ton choix est gagnant.`,
            '',
            boost
              ? `⚡ Avec le boost x2 : **${BASE[number] * 2} ${UNIT}**.`
              : 'Ton boost de cette journée est déjà utilisé.',
            '',
            'Une fois confirmé, ton pronostic ne peut plus être modifié.',
          ].join('\n'),
        );

      const choices = [
        button(
          `md:confirm:${matchId}:${number}:0:${match.revision}`,
          '✅ Confirmer',
          ButtonStyle.Success,
        ),
      ];

      if (boost) {
        choices.push(
          button(
            `md:confirm:${matchId}:${number}:1:${match.revision}`,
            '⚡ Confirmer + Boost x2',
            ButtonStyle.Primary,
          ),
        );
      }

      choices.push(button('md:cancel', 'Annuler'));

      return interaction.editReply({
        content: '',
        embeds: [targetEmbed],
        components: [row(...choices)],
      });
    }

    if (action === 'confirm') {
      await store.change(state =>
        place(
          state,
          matchId,
          interaction.user.id,
          number,
          revision === '1',
          Number(finalRevision || match.revision),
          interaction.user.username,
        ),
      );

      const latest = await store.read();

      return interaction.editReply(
        myCard(
          latest,
          getMatch(latest, matchId),
          interaction.user.id,
        ),
      );
    }
  }

  client.on(Events.InteractionCreate, async interaction => {
    if (stopping) return;

    const knownCommand =
      interaction.isChatInputCommand() &&
      commands.some(
        command => command.name === interaction.commandName,
      );

    const knownButton =
      interaction.isButton() &&
      /^(md:|bet_|confirm_|cancel_bet$)/.test(interaction.customId);

    if (!knownCommand && !knownButton) return;

    try {
      if (interaction.isChatInputCommand()) {
        await slash(interaction);
      } else {
        await buttons(interaction);
      }
    } catch (error) {
      if (!(error instanceof UserError)) {
        log('Interaction', error);
      }

      const payload = {
        content: error instanceof UserError
          ? `⚠️ ${error.message}`
          : 'Une erreur est survenue. Consulte les logs du bot.',
        allowedMentions: quiet,
      };

      try {
        if (interaction.deferred || interaction.replied) {
          if (interaction.isButton() || interaction.ephemeral) {
            await interaction.editReply({
              ...payload,
              embeds: [],
              components: [],
            });
          } else {
            await interaction.followUp({
              ...payload,
              flags: MessageFlags.Ephemeral,
            });
          }
        } else {
          await interaction.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        log('Réponse erreur', replyError);
      }
    }
  });

  client.on(Events.Error, error => log('Discord', error));

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);

      if (staffId) await channel(staffId);

      for (const command of commands) {
        await guild.commands.create(command.toJSON());
      }

      const globals = await client.application.commands.fetch();

      for (const command of globals.values()) {
        if (commands.some(item => item.name === command.name)) {
          await client.application.commands.delete(command.id);
        }
      }

      console.log(
        `MatchDay prêt : ${client.user.tag}. ` +
        `Fuseau : ${TZ}. Stockage : ${store.file}.`,
      );

      await tick();

      timer = setInterval(() => void tick(), 15000);
    } catch (error) {
      log('Initialisation', error);
      void stop(1);
    }
  });

  async function stop(code = 0) {
    if (stopping) return;

    stopping = true;

    clearInterval(timer);
    client.destroy();

    await store.queue;

    process.exit(code);
  }

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  process.once('uncaughtException', error => {
    log('Erreur fatale', error);
    void stop(1);
  });

  process.once('unhandledRejection', error => {
    log('Erreur fatale', error);
    void stop(1);
  });

  await client.login(env.DISCORD_TOKEN);
}

if (
  require.main === module ||
  process.env.MATCHDAY_ENTRYPOINT === 'src'
) {
  run().catch(error => {
    console.error(
      `Démarrage : ${
        error instanceof UserError
          ? error.message
          : error.code || error.name
      }`,
    );

    process.exitCode = 1;
  });
} else {
  module.exports = {
    initial,
    migrate,
    Store,
    parseTime,
    day,
    sportDay,
    monday,
    shift,
    rank,
    earned,
    place,
    result,
    isOpen,
    weekCard,
    weekMatches,
    matchCard,
    commands,
    EDITION,
    programBlocks,
    validateProgram,
  };
}
