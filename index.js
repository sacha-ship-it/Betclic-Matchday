'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const {
  Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits: P,
  SlashCommandBuilder, ChannelType, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder, escapeMarkdown,
} = require('discord.js');

const TZ = process.env.TIMEZONE || 'Europe/Paris';
const UNIT = process.env.POINTS_LABEL || 'crânes';
const ICON = process.env.POINTS_EMOJI || '💀';

const COLOR = /^#[a-f\d]{6}$/i.test(process.env.MATCHDAY_COLOR || '')
  ? process.env.MATCHDAY_COLOR
  : '#E10014';

const BASE = { 1: 2, 2: 4, 3: 8 };
const EMOJIS = { 1: '🤙', 2: '⚡', 3: '🔥' };
const NAMES = { 1: 'Chill', 2: 'Joueur', 3: 'Vraiiiment joueur' };

const EDITION = {
  title: 'BETCLIC MATCHDAY',
  description: 'Retrouve ici les prochains MatchDays.',
  blocks: { mardi: '', mercredi: '', jeudi: '', weekend: '' },
};

const GROUPS = {
  mardi: '⚽ MARDI',
  mercredi: '⚽ MERCREDI',
  jeudi: '⚽ JEUDI',
  weekend: '🔥 LE WEEK-END',
};

const quiet = { parse: [] };
const uid = () => randomUUID().replaceAll('-', '').slice(0, 16);
const copy = x => structuredClone(x);

class UserError extends Error {}

function need(ok, text) {
  if (!ok) throw new UserError(text);
}

const safe = x =>
  escapeMarkdown(String(x)).replaceAll('@', '@\u200b');

const digest = x =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');

const clean = (x, max, label) => {
  const s = String(x || '').trim().replace(/[\u2013\u2014]/g, '-');
  need(s.length > 0 && s.length <= max, `${label} : entre 1 et ${max} caractères.`);
  return s;
};

function fixtures(text) {
  return String(text || '')
    .split(/\s+\/\s+|\r?\n|\\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

function programBlocks(p) {
  return Object.entries(GROUPS)
    .filter(([key]) => fixtures(p.blocks?.[key]).length);
}

function validateProgram(p) {
  dateKey(p.start);
  dateKey(p.end);
  need(p.start <= p.end, 'La date de début doit précéder la date de fin.');

  for (const [key] of programBlocks(p)) {
    const text = fixtures(p.blocks[key])
      .map(x => '• ' + safe(x))
      .join('\n');

    need(
      text.length <= 1000,
      `Le groupe ${key} est trop long : raccourcis les noms ou les horaires.`
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
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );
}

function day(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function dateKey(s) {
  need(/^\d{4}-\d{2}-\d{2}$/.test(s || ''), 'Date attendue : AAAA-MM-JJ.');

  const t = Date.parse(s + 'T12:00:00Z');

  need(
    Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s,
    'Date invalide.'
  );

  return s;
}

function shift(s, n) {
  return new Date(
    Date.parse(dateKey(s) + 'T12:00:00Z') + n * 86400000
  ).toISOString().slice(0, 10);
}

function monday(s) {
  const w = new Date(dateKey(s) + 'T12:00:00Z').getUTCDay();
  return shift(s, -(w === 0 ? 6 : w - 1));
}

function sportDay(ms = Date.now()) {
  return Number(parts(ms).hour) < 12 ? shift(day(ms), -1) : day(ms);
}

function time(ms) {
  const p = parts(ms);
  return `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}`;
}

function dateLabel(s) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(s + 'T12:00:00Z'));
}

function parseTime(s) {
  let text = String(s || '').trim();

  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }

  need(
    /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text),
    'Heure attendue : AAAA-MM-JJ HH:mm, exemple 2026-10-26 09:00.'
  );

  dateKey(text.slice(0, 10));

  const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
  const matches = [];

  for (let n = -840; n <= 840; n += 15) {
    const t = utc + n * 60000;
    const p = parts(t);

    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === text) {
      matches.push(t);
    }
  }

  need(
    matches.length === 1,
    matches.length
      ? 'Heure ambiguë au changement d’heure. Choisis un autre horaire.'
      : 'Cette date ou cette heure n’existe pas.'
  );

  return matches[0];
}

function imageURL(s) {
  if (!s) return '';

  let u;

  try {
    u = new URL(s);
  } catch {
    throw new UserError('URL image invalide.');
  }

  need(
    u.protocol === 'https:' && !u.username && !u.password && s.length <= 1000,
    'Utilise une URL image HTTPS de moins de 1 000 caractères.'
  );

  return s;
}

function odds(s) {
  const n = Number(String(s).trim().replace(',', '.'));

  need(
    Number.isFinite(n) && n >= 1 && n <= 10000,
    'Cote invalide : utilise par exemple 1,80.'
  );

  return String(s).trim();
}

const closeAt = m => Date.parse(m.closingTimeUTC);

function isOpen(m, now = Date.now()) {
  return m.status === 'open' && m.result === null && now < closeAt(m);
}

function getMatch(s, id) {
  const m = s.matches[id];

  need(
    m && m.status !== 'deleted',
    'Match introuvable. Utilise /list-matches pour retrouver son ID.'
  );

  return m;
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

function migrate(s) {
  need(
    s && s.matches && s.bets && s.users && (!s.schema || s.schema === 3),
    'Format de sauvegarde inconnu. Ne supprime pas le fichier db.json.'
  );

  s.schema = 3;
  s.programs ||= {};
  s.boosts ||= {};
  s.pending ||= {};
  s.archives ||= [];

  for (const m of Object.values(s.matches)) {
    need(
      Number.isFinite(closeAt(m)),
      `Date de fermeture invalide dans le match ${m.id}.`
    );

    m.result = m.result == null
      ? null
      : Array.isArray(m.result)
        ? m.result
        : [m.result];

    m.publishAt ??= m.messageId ? 0 : Date.now();
    m.date ||= sportDay(closeAt(m));
    m.revision ||= 1;
    m.version ||= 1;
    m.description ||= '';
    m.roleId ||= null;
    m.imageUrl ||= '';
    m.dirty = true;
    m.published ||= Boolean(m.messageId);
    m.imageFile ||= '';

    for (const [id, b] of Object.entries(s.bets[m.id] || {})) {
      b.revision ||= m.revision;

      if (b.boosted) {
        const key = b.boostDay || m.date;
        s.boosts[key] ||= {};
        s.boosts[key][id] ||= m.id;
      }
    }
  }

  for (const p of Object.values(s.programs)) {
    if (!p.blocks) {
      p.blocks = Object.fromEntries(
        Object.keys(GROUPS).map(key => [key, ''])
      );

      const selected = Object.values(s.matches)
        .filter(m =>
          m.status !== 'deleted' &&
          m.channelId === (p.matchesChannelId || p.channelId) &&
          m.date >= p.start &&
          m.date <= p.end
        )
        .sort((a, b) => closeAt(a) - closeAt(b));

      for (const m of selected) {
        const weekday = new Date(m.date + 'T12:00:00Z').getUTCDay();

        const key = {
          2: 'mardi',
          3: 'mercredi',
          4: 'jeudi',
        }[weekday] || 'weekend';

        p.blocks[key] += (p.blocks[key] ? ' / ' : '') + m.title;
      }
    }

    p.version ||= 1;
    p.dirty = true;
  }

  return s;
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
        JSON.parse(await fs.readFile(this.file, 'utf8'))
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.state = initial();
    }

    await this.write(this.state);
  }

  async write(s) {
    const h = await fs.open(this.file + '.tmp', 'w', 0o600);

    try {
      await h.writeFile(JSON.stringify(s));
      await h.sync();
    } finally {
      await h.close();
    }

    try {
      await fs.copyFile(this.file, this.file + '.bak');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }

    await fs.rename(this.file + '.tmp', this.file);
  }

  async read() {
    await this.queue;
    return copy(this.state);
  }

  change(fn) {
    const task = this.queue.then(async () => {
      const next = copy(this.state);
      const r = await fn(next);

      await this.write(next);
      this.state = next;

      return copy(r);
    });

    this.queue = task.catch(() => {});
    return task;
  }
}

function earned(m, b) {
  return (
    m.status !== 'deleted' &&
    b.revision === m.revision &&
    m.result?.includes(b.choice)
  )
    ? BASE[b.choice] * (b.boosted ? 2 : 1)
    : 0;
}

function rank(s, range = {}) {
  const users = new Map();

  for (const m of Object.values(s.matches)) {
    if (
      m.status === 'deleted' ||
      range.start && m.date < range.start ||
      range.end && m.date > range.end
    ) continue;

    for (const [id, b] of Object.entries(s.bets[m.id] || {})) {
      if (b.revision !== m.revision) continue;

      const r = users.get(id) || {
        id,
        name: s.users[id]?.username || b.username || id,
        points: 0,
        first: Infinity,
      };

      r.points += earned(m, b);
      r.first = Math.min(r.first, b.placedAt || Infinity);
      users.set(id, r);
    }
  }

  return [...users.values()]
    .filter(r => r.points > 0)
    .sort((a, b) =>
      b.points - a.points ||
      a.first - b.first ||
      a.id.localeCompare(b.id)
    );
}

function boostAvailable(s, userId, now = Date.now()) {
  const key = sportDay(now);

  return !s.boosts[key]?.[userId] &&
    s.users[userId]?.boostUsedToday !== key;
}

function place(s, mid, userId, choice, boost, revision, username, now = Date.now()) {
  const m = getMatch(s, mid);

  need(isOpen(m, now), 'Les mises sont fermées.');

  need(
    m.revision === revision && BASE[choice],
    'Ce choix a changé. Repars du message du match.'
  );

  need(
    !s.bets[mid]?.[userId],
    'Tu as déjà participé. Ton pronostic ne peut plus être modifié.'
  );

  need(
    !boost || boostAvailable(s, userId, now),
    'Ton boost a déjà été utilisé pour cette journée.'
  );

  const key = sportDay(now);

  s.bets[mid] ||= {};
  s.users[userId] ||= { totalPoints: 0 };

  s.bets[mid][userId] = {
    choice,
    boosted: boost,
    revision,
    username,
    placedAt: now,
    boostDay: boost ? key : null,
    points: null,
  };

  Object.assign(s.users[userId], {
    username,
    firstBetAt: s.users[userId].firstBetAt || now,
  });

  if (boost) {
    s.boosts[key] ||= {};
    s.boosts[key][userId] = mid;
    s.users[userId].boostUsedToday = key;
  }
}

function result(s, mid, winners) {
  const m = getMatch(s, mid);

  m.result = winners;
  m.status = 'closed';
  m.dirty = true;
  m.version++;

  for (const b of Object.values(s.bets[mid] || {})) {
    b.points = earned(m, b);
  }

  for (const u of Object.values(s.users)) {
    u.totalPoints = 0;
  }

  for (const r of rank(s)) {
    if (s.users[r.id]) s.users[r.id].totalPoints = r.points;
  }
}

function rangeOptions(o) {
  const start = o.getString('debut');
  const end = o.getString('fin');

  if (start || end) {
    need(start && end, 'Renseigne debut ET fin.');
    dateKey(start);
    dateKey(end);
    need(start <= end, 'Période invalide.');

    return { start, end, label: `du ${start} au ${end}` };
  }

  const type = o.getString('type') || 'week';

  if (type === 'general') return { label: 'général' };

  if (type === 'today') {
    const d = sportDay();
    return { start: d, end: d, label: `du ${d}` };
  }

  const d = monday(day(Date.now()));

  return {
    start: d,
    end: shift(d, 6),
    label: `du ${d} au ${shift(d, 6)}`,
  };
}

function embed(title) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setFooter({ text: 'Betclic MatchDay' });
}

const button = (
  id,
  label,
  style = ButtonStyle.Secondary,
  disabled = false
) => new ButtonBuilder()
  .setCustomId(id)
  .setLabel(label.slice(0, 80))
  .setStyle(style)
  .setDisabled(disabled);

const row = (...buttons) =>
  new ActionRowBuilder().addComponents(buttons);

function media(x, e) {
  if (x.imageFile) {
    const name = path.basename(x.imageFile);
    e.setImage(`attachment://${name}`);

    return {
      files: [new AttachmentBuilder(x.imageFile, { name })],
    };
  }

  if (x.imageUrl) e.setImage(x.imageUrl);
  return {};
}

function longText(e, intro, suffix) {
  e.setDescription(suffix || null);

  const budget = Math.min(
    4096 - suffix.length,
    6000 - e.length
  );

  let content = '';
  let rest = intro;

  if (intro.length > budget) {
    const required = intro.length - budget;

    need(
      required <= 1900,
      'Le message complet est trop long pour Discord : raccourcis le texte ou les autres informations.'
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
    'Le message complet est trop long après mise en forme : raccourcis légèrement le texte.'
  );

  e.setDescription(rest + suffix);
  return content;
}

function matchCard(m) {
  const open = isOpen(m);
  const e = embed(m.title).setColor(open ? COLOR : 0x7F1D1D);

  const intro = m.description
    ? m.description
    : 'Choisis ton pronostic et tente de grimper au classement de la semaine !';

  const lines = [
    '',
    '',
    `🕒 **Fin des mises : ${time(closeAt(m))}**`,
    '',
  ];

  for (const n of [1, 2, 3]) {
    lines.push(
      `${EMOJIS[n]} **${safe(m['choice' + n + 'Label'])}**`,
      `*Cote : ${safe(m['choice' + n + 'Odds'])}* · ${ICON} **${BASE[n]} ${UNIT}**`,
      ''
    );
  }

  lines.push(
    '⚡ Un boost par journée pour doubler tes gains de points.',
    'Une fois confirmé, ton pronostic est définitif.'
  );

  if (!open) {
    lines.push(
      '',
      m.result
        ? '🔒 Résultats enregistrés.'
        : '🔒 Les mises sont fermées.'
    );
  }

  e.setFooter({ text: `Betclic MatchDay | Match ${m.id}` });

  const content = longText(e, intro, lines.join('\n'));

  return {
    content,
    embeds: [e],
    ...media(m, e),
    components: [
      row(
        ...[1, 2, 3].map(n => button(
          `md:bet:${m.id}:${n}:${m.revision}`,
          `${EMOJIS[n]} ${NAMES[n]} (+${BASE[n]} ${UNIT})`,
          [
            0,
            ButtonStyle.Secondary,
            ButtonStyle.Primary,
            ButtonStyle.Danger,
          ][n],
          !open
        )),
        button(`md:my:${m.id}`, '📋 Mon choix')
      ),
    ],
    allowedMentions: quiet,
  };
}

function myCard(s, m, userId) {
  const b = s.bets[m.id]?.[userId];

  if (!b) {
    return {
      content: 'Tu n’as pas encore validé de pronostic sur ce match.',
      embeds: [],
      components: [],
    };
  }

  const e = embed('✅ Ton pronostic est enregistré')
    .setColor(0x22C55E)
    .setDescription([
      `**${safe(m.title)}**`,
      '',
      `${EMOJIS[b.choice]} **${safe(m['choice' + b.choice + 'Label'])}**`,
      '',
      `${ICON} **${BASE[b.choice] * (b.boosted ? 2 : 1)} ${UNIT}** si ton choix est gagnant.${b.boosted ? ' Boost x2 activé.' : ''}`,
      '',
      'Ton choix est définitif.',
      m.result
        ? `\nRésultat : **${earned(m, b)} ${UNIT} gagnés**.`
        : '',
    ].join('\n'));

  return {
    content: '',
    embeds: [e],
    components: [],
    allowedMentions: quiet,
  };
}

function weekMatches(s, p) {
  return programBlocks(p).flatMap(([key]) =>
    fixtures(p.blocks[key]).map(title => ({
      title,
      group: key,
    }))
  );
}

function weekCard(s, p) {
  const groups = programBlocks(p);
  const custom = Boolean(String(p.description || '').trim());
  const intro = custom ? p.description : EDITION.description;
  const e = embed(p.title);

  for (const [key, label] of (custom ? [] : groups)) {
    const date = key === 'weekend' ? '' : (() => {
      const target = {
        mardi: 2,
        mercredi: 3,
        jeudi: 4,
      }[key];

      for (let d = p.start; d <= p.end; d = shift(d, 1)) {
        if (new Date(d + 'T12:00:00Z').getUTCDay() === target) {
          return ' ' + d.slice(8) + '/' + d.slice(5, 7);
        }
      }

      return '';
    })();

    const chunks = [];
    let chunk = '';

    for (const fixture of fixtures(p.blocks[key])) {
      const line = '• ' + safe(fixture);

      if (chunk && chunk.length + line.length + 1 > 1024) {
        chunks.push(chunk);
        chunk = '';
      }

      chunk += (chunk ? '\n' : '') + line;
    }

    if (chunk) chunks.push(chunk);

    chunks.forEach((value, n) => {
      e.addFields({
        name: label + date + (n ? ' (suite)' : ''),
        value: value + '\n\u200b',
        inline: false,
      });
    });
  }

  if (!custom && p.rulesChannelId) {
    e.addFields({
      name: '📋 Règlement',
      value: `<#${p.rulesChannelId}>`,
    });
  }

  const disclaimer = /freebets?/i.test(intro)
    ? ' | Freebets = crédits de jeu non retirables'
    : '';

  e.setFooter({
    text: `Betclic MatchDay | Programme ${p.id}${disclaimer}`,
  });

  const content = longText(e, intro, '');

  return {
    content,
    embeds: [e],
    ...media(p, e),
    components: [],
    allowedMentions: quiet,
  };
}

function staffCard(x, kind) {
  const fields = [
    { name: 'ID', value: `\`${x.id}\`` },
    { name: 'Statut', value: x.status, inline: true },
    { name: 'Salon', value: `<#${x.channelId}>`, inline: true },
    {
      name: 'Publication',
      value: x.publishAt ? time(x.publishAt) : 'Immédiate',
    },
  ];

  if (kind === 'matches') {
    fields.push(
      {
        name: 'Fin des mises',
        value: time(closeAt(x)),
        inline: true,
      },
      {
        name: 'Journée sportive',
        value: x.date,
        inline: true,
      }
    );
  } else {
    fields.push(
      { name: 'Semaine', value: `${x.start} au ${x.end}` },
      {
        name: 'Salon des matchs',
        value: `<#${x.matchesChannelId || x.channelId}>`,
      }
    );
  }

  return {
    embeds: [
      embed(x.title)
        .addFields(fields)
        .setFooter({
          text: `Betclic MatchDay | Staff ${kind} ${x.id}`,
        }),
    ],
    allowedMentions: quiet,
  };
}

function rankCard(s, r, page = 0) {
  const all = rank(s, r);
  const pages = Math.max(1, Math.ceil(all.length / 20));

  page = Math.max(0, Math.min(Number(page) || 0, pages - 1));

  const pending = Object.values(s.matches).filter(m =>
    m.status !== 'deleted' &&
    (!r.start || m.date >= r.start) &&
    (!r.end || m.date <= r.end) &&
    m.result === null
  ).length;

  const e = embed(`🏆 Classement ${r.label}`)
    .setDescription(
      all.slice(page * 20, page * 20 + 20)
        .map((u, n) =>
          `${['🥇', '🥈', '🥉'][page * 20 + n] || `**${page * 20 + n + 1}.**`} <@${u.id}> | ${ICON} **${u.points} ${UNIT}**`
        )
        .join('\n') || 'Aucun point pour le moment.'
    )
    .setFooter({
      text: `Betclic MatchDay | Page ${page + 1}/${pages}`,
    });

  if (pending) {
    e.addFields({
      name: '⏳ Classement provisoire',
      value: `${pending} résultat(s) en attente sur cette période.`,
    });
  }

  e.addFields({
    name: 'En cas d’égalité',
    value: 'La première participation sur la période départage les membres.',
  });

  return {
    content: '',
    embeds: [e],
    components: pages > 1 ? [
      row(
        button(
          `md:rank:${r.start || 'all'}:${r.end || 'all'}:${page - 1}`,
          '←',
          ButtonStyle.Secondary,
          page === 0
        ),
        button(
          `md:rank:${r.start || 'all'}:${r.end || 'all'}:${page + 1}`,
          '→',
          ButtonStyle.Secondary,
          page === pages - 1
        )
      ),
    ] : [],
    allowedMentions: quiet,
  };
}

function matchOptions(c, editing = false) {
  if (editing) {
    c.addStringOption(o => o
      .setName('match_id')
      .setDescription('ID dans le salon staff ou /list-matches')
      .setRequired(true)
    );
  }

  c.addStringOption(o => o
    .setName('titre')
    .setDescription('Titre libre du MatchDay')
    .setMaxLength(180)
    .setRequired(!editing)
  ).addStringOption(o => o
    .setName('fermeture')
    .setDescription('Fin des mises : AAAA-MM-JJ HH:mm, heure configurée')
    .setRequired(!editing)
  );

  for (const n of [1, 2, 3]) {
    c.addStringOption(o => o
      .setName(`choix${n}_label`)
      .setDescription(`Choix ${n} : ${BASE[n]} points`)
      .setMaxLength(180)
      .setRequired(!editing)
    ).addStringOption(o => o
      .setName(`choix${n}_cote`)
      .setDescription(`Cote indicative du choix ${n}`)
      .setMaxLength(20)
      .setRequired(!editing)
    );
  }

  c.addStringOption(o => o
    .setName('publication')
    .setDescription('AAAA-MM-JJ HH:mm, sinon publication immédiate')
  )
    .addChannelOption(o => o
      .setName('channel')
      .setDescription('Salon cible, sinon salon actuel')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
    )
    .addStringOption(o => o
      .setName('journee')
      .setDescription('Journée sportive AAAA-MM-JJ, sinon déduite du début du match')
    )
    .addStringOption(o => o
      .setName('texte')
      .setDescription('Présentation facultative, jusqu’à 5 000 caractères')
      .setMaxLength(5000)
    )
    .addStringOption(o => o
      .setName('image')
      .setDescription('URL du visuel, facultatif')
      .setMaxLength(1000)
    )
    .addRoleOption(o => o
      .setName('notification')
      .setDescription('Rôle à notifier à la publication, facultatif')
    );

  if (editing) {
    c.addBooleanOption(o => o
      .setName('retirer_image')
      .setDescription('Supprimer le visuel')
    )
      .addBooleanOption(o => o
        .setName('retirer_notification')
        .setDescription('Retirer la notification')
      )
      .addBooleanOption(o => o
        .setName('retirer_texte')
        .setDescription('Revenir au texte de base')
      );
  }

  return c;
}

function programOptions(c, editing = false) {
  if (editing) {
    c.addStringOption(o => o
      .setName('programme_id')
      .setDescription('ID du programme dans le salon staff')
      .setRequired(true)
    );
  }

  c.addChannelOption(o => o
    .setName('channel')
    .setDescription('Salon de l’annonce, sinon salon actuel')
    .addChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement
    )
  )
    .addStringOption(o => o
      .setName('publication')
      .setDescription('AAAA-MM-JJ HH:mm, heure de Paris, sinon immédiate')
    )
    .addChannelOption(o => o
      .setName('salon_matchs')
      .setDescription('Salon où les membres participent aux MatchDays')
      .addChannelTypes(
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement
      )
    )
    .addStringOption(o => o
      .setName('image')
      .setDescription('Lien du visuel de l’annonce')
      .setMaxLength(1000)
    )
    .addStringOption(o => o
      .setName('titre')
      .setDescription('Titre libre de l’annonce, sinon BETCLIC MATCHDAY')
      .setMaxLength(180)
    )
    .addStringOption(o => o
      .setName('texte')
      .setDescription('Introduction personnalisée, jusqu’à 5 000 caractères')
      .setMaxLength(5000)
    )
    .addStringOption(o => o
      .setName('debut')
      .setDescription('Début AAAA-MM-JJ, sinon lundi de la semaine actuelle')
    )
    .addStringOption(o => o
      .setName('fin')
      .setDescription('Fin AAAA-MM-JJ, sinon dimanche de la semaine actuelle')
    );

  for (const key of Object.keys(GROUPS)) {
    c.addStringOption(o => o
      .setName(key)
      .setDescription(
        `Affiches du groupe ${key}, séparées par / ; « aucun » pour le retirer`
      )
      .setMaxLength(450)
    );
  }

  c.addRoleOption(o => o
    .setName('notification')
    .setDescription('Rôle à notifier à la publication, facultatif')
  ).addChannelOption(o => o
    .setName('reglement')
    .setDescription('Salon du règlement, facultatif')
    .addChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement
    )
  );

  if (editing) {
    c.addBooleanOption(o => o
      .setName('retirer_image')
      .setDescription('Supprimer le visuel')
    )
      .addBooleanOption(o => o
        .setName('retirer_notification')
        .setDescription('Retirer la notification')
      )
      .addBooleanOption(o => o
        .setName('retirer_texte')
        .setDescription('Revenir au texte de base')
      );
  }

  return c;
}

function ranges(c) {
  return c
    .addStringOption(o => o
      .setName('type')
      .setDescription('Semaine actuelle par défaut')
      .addChoices(
        { name: 'Semaine', value: 'week' },
        { name: 'Journée sportive', value: 'today' },
        { name: 'Général', value: 'general' }
      )
    )
    .addStringOption(o => o
      .setName('debut')
      .setDescription('Période personnalisée : AAAA-MM-JJ')
    )
    .addStringOption(o => o
      .setName('fin')
      .setDescription('Fin personnalisée : AAAA-MM-JJ')
    );
}

const adminCommand = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(P.Administrator);

const idOption = (c, name = 'match_id') =>
  c.addStringOption(o => o
    .setName(name)
    .setDescription('Identifiant dans la fiche staff')
    .setRequired(true)
  );

const commands = [
  matchOptions(
    adminCommand('create-match', 'Créer un MatchDay immédiat ou programmé')
  ),

  matchOptions(
    adminCommand('edit-match', 'Modifier un MatchDay'),
    true
  ),

  idOption(
    adminCommand('close-match', 'Fermer immédiatement les mises')
  ),

  idOption(
    adminCommand('delete-match', 'Supprimer un MatchDay avec confirmation')
  ),

  idOption(
    adminCommand('set-result', 'Enregistrer ou corriger les choix gagnants')
  )
    .addBooleanOption(o => o
      .setName('choix1')
      .setDescription('Le choix 1 est gagnant')
    )
    .addBooleanOption(o => o
      .setName('choix2')
      .setDescription('Le choix 2 est gagnant')
    )
    .addBooleanOption(o => o
      .setName('choix3')
      .setDescription('Le choix 3 est gagnant')
    )
    .addBooleanOption(o => o
      .setName('annule')
      .setDescription('Annuler le match : aucun point')
    ),

  programOptions(
    adminCommand('schedule-week', 'Créer l’annonce du programme de la semaine')
  ),

  programOptions(
    adminCommand('edit-week', 'Modifier l’annonce de la semaine'),
    true
  ),

  idOption(
    adminCommand('delete-week', 'Supprimer un programme avec confirmation'),
    'programme_id'
  ),

  ranges(
    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Afficher le classement sur demande')
  ).addBooleanOption(o => o
    .setName('prive')
    .setDescription('Afficher uniquement pour toi')
  ),

  adminCommand(
    'list-matches',
    'Lister les MatchDays et les programmes'
  ).addStringOption(o => o
    .setName('semaine')
    .setDescription('Filtrer sur une date AAAA-MM-JJ de la semaine')
  ),

  ranges(
    adminCommand('export', 'Exporter les pronostics et le classement en CSV')
  ),

  adminCommand(
    'reset-scores',
    'Archiver et remettre à zéro tous les matchs et points, avec confirmation'
  ),

  adminCommand(
    'diagnostic',
    'Vérifier la sauvegarde et les programmations'
  ),
];

async function cacheImage(x, dir) {
  x.imageFile = '';
  if (!x.imageUrl) return;

  const u = new URL(x.imageUrl);

  if (![
    'cdn.discordapp.com',
    'media.discordapp.net',
  ].includes(u.hostname)) return;

  const r = await fetch(u, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });

  need(
    r.ok,
    'Lien Discord expiré ou inaccessible. Recopie le lien de l’image.'
  );

  const ext = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }[r.headers.get('content-type')?.split(';')[0]];

  need(ext, 'Image attendue : PNG, JPG, WEBP ou GIF.');

  need(
    Number(r.headers.get('content-length') || 0) <= 8 * 1024 * 1024,
    'Image trop lourde : 8 Mo maximum.'
  );

  const chunks = [];
  let size = 0;

  for await (const c of r.body) {
    size += c.length;
    need(size <= 8 * 1024 * 1024, 'Image trop lourde : 8 Mo maximum.');
    chunks.push(c);
  }

  const buffer = Buffer.concat(chunks);
  const folder = path.join(dir, 'images');

  await fs.mkdir(folder, { recursive: true });

  x.imageFile = path.join(
    folder,
    `${x.id}-${createHash('sha256')
      .update(buffer)
      .digest('hex')
      .slice(0, 12)}${ext}`
  );

  await fs.writeFile(x.imageFile, buffer, { mode: 0o600 });
}

async function run() {
  const env = process.env;
  const guildId = env.DISCORD_GUILD_ID?.trim();
  const staffId = env.DISCORD_ADMIN_CHANNEL_ID?.trim();

  need(
    env.DISCORD_TOKEN && /^\d{17,20}$/.test(guildId || ''),
    'Renseigne DISCORD_TOKEN et DISCORD_GUILD_ID.'
  );

  need(
    !staffId || /^\d{17,20}$/.test(staffId),
    'DISCORD_ADMIN_CHANNEL_ID invalide.'
  );

  parts(Date.now());

  const dir =
    env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    './data';

  if (env.RAILWAY_ENVIRONMENT_ID) {
    need(
      env.RAILWAY_VOLUME_MOUNT_PATH &&
      path.resolve(dir) === path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH),
      'Attache le volume et fais correspondre DATA_DIR à son chemin.'
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

  const admin = i => need(
    i.memberPermissions?.has(P.Administrator),
    'Cette commande est réservée aux administrateurs.'
  );

  const log = (label, e) => {
    const message = String(e?.message || 'Erreur sans détail')
      .replaceAll(env.DISCORD_TOKEN, '[TOKEN MASQUÉ]');

    console.error(
      `${label}: ${e?.code || e?.name || 'Erreur'} | ${message.slice(0, 1500)}`
    );
  };

  async function channel(id) {
    const c = await client.channels.fetch(id);

    need(
      c &&
      c.guildId === guildId &&
      [
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
      ].includes(c.type),
      'Salon inaccessible ou sur un autre serveur.'
    );

    need(
      c.permissionsFor(client.user)?.has([
        P.ViewChannel,
        P.SendMessages,
        P.EmbedLinks,
        P.AttachFiles,
        P.ReadMessageHistory,
      ]),
      'Il manque au bot une permission : voir le salon, envoyer, intégrer des liens, joindre des fichiers ou lire l’historique.'
    );

    return c;
  }

  async function fetchMessage(c, id) {
    try {
      return await c.messages.fetch(id);
    } catch (e) {
      if (e.code !== 10008) throw e;
      return null;
    }
  }

  async function findMessage(c, marker, since) {
    if (!since) return null;

    let before;

    for (let n = 0; n < 100; n++) {
      const list = await c.messages.fetch({
        limit: 100,
        ...(before ? { before } : {}),
      });

      if (!list.size) return null;

      const found = list.find(m =>
        m.author.id === client.user.id &&
        m.embeds.some(e => e.footer?.text?.startsWith(marker))
      );

      if (found) return found;

      const last = list.last();
      if (last.createdTimestamp < since - 10000) return null;

      before = last.id;
    }

    throw new Error(
      'Historique trop long pour vérifier un envoi interrompu.'
    );
  }

  async function syncStaff(x, kind) {
    if (!staffId) return;

    const payload = staffCard(x, kind);
    const hash = digest(payload.embeds.map(e => e.toJSON()));

    if (
      x.staffHash === hash &&
      x.staffChannelId === staffId
    ) return;

    const c = await channel(staffId);

    let previous =
      x.staffChannelId === staffId && x.staffMessageId
        ? await fetchMessage(c, x.staffMessageId)
        : null;

    if (!previous && x.staffSendingAt) {
      previous = await findMessage(
        c,
        `Betclic MatchDay | Staff ${kind} ${x.id}`,
        x.staffSendingAt
      );
    }

    if (!previous && !x.staffSendingAt) {
      await store.change(s => {
        s[kind][x.id].staffSendingAt = Date.now();
      });
    }

    const message = previous
      ? await previous.edit(payload)
      : await c.send({
          ...payload,
          nonce: BigInt(
            '0x' + digest(`staff:${kind}:${x.id}`).slice(0, 16)
          ).toString(),
          enforceNonce: true,
        });

    await store.change(s => {
      Object.assign(s[kind][x.id], {
        staffMessageId: message.id,
        staffChannelId: staffId,
        staffHash: hash,
      });
    });
  }

  async function publish(x, kind, s) {
    const isWeek = kind === 'programs';

    if (x.status === 'deleted') {
      if (x.messageId) {
        const c = await channel(x.postChannelId || x.channelId);
        const msg = await fetchMessage(c, x.messageId);

        if (msg) await msg.delete();

        await store.change(db => {
          db[kind][x.id].messageId = null;
        });
      }

      return;
    }

    if (!x.published && x.publishAt > Date.now()) return;

    if (!isWeek && !x.published && closeAt(x) <= Date.now()) {
      if (!x.missed) {
        await store.change(db => {
          db.matches[x.id].missed = true;
          db.matches[x.id].status = 'closed';
          db.matches[x.id].version++;
        });

        log(
          `Publication manquée ${x.id}`,
          new Error('Le match est déjà commencé. Il n’a pas été publié.')
        );
      }

      return;
    }

    const payload = isWeek
      ? weekCard(s, x)
      : matchCard({
          ...x,
          status: x.status === 'scheduled' ? 'open' : x.status,
        });

    const hash = digest({
      content: payload.content || '',
      embeds: payload.embeds.map(e => e.toJSON()),
      components: payload.components.map(r => r.toJSON()),
      image: x.imageUrl,
      file: x.imageFile,
    });

    if (
      x.published &&
      x.publicHash === hash &&
      !x.dirty
    ) return;

    if (
      x.messageId &&
      x.postChannelId &&
      x.postChannelId !== x.channelId
    ) {
      const oldC = await channel(x.postChannelId);
      const old = await fetchMessage(oldC, x.messageId);

      if (old) await old.delete();

      await store.change(db => {
        const e = db[kind][x.id];
        e.messageId = null;
        e.sendingAt = null;
      });

      x.messageId = null;
      x.sendingAt = null;
    }

    const c = await channel(x.channelId);

    let previous = x.messageId
      ? await fetchMessage(c, x.messageId)
      : null;

    if (!previous && !x.messageId && x.sendingAt) {
      previous = await findMessage(
        c,
        isWeek
          ? `Betclic MatchDay | Programme ${x.id} |`
          : `Betclic MatchDay | Match ${x.id}`,
        x.sendingAt
      );
    }

    if (!previous && !x.sendingAt) {
      x.sendingAt = Date.now();

      await store.change(db => {
        db[kind][x.id].sendingAt = x.sendingAt;
      });
    }

    const notify = !x.published && x.roleId;

    const message = previous
      ? await previous.edit({
          ...payload,
          attachments: [],
          content: payload.content || '',
          allowedMentions: quiet,
        })
      : await c.send({
          ...payload,
          content: [
            notify ? `<@&${x.roleId}>` : '',
            payload.content || '',
          ].filter(Boolean).join('\n\n'),
          allowedMentions: notify
            ? { parse: [], roles: [x.roleId] }
            : quiet,
          nonce: BigInt(
            '0x' + digest(
              `${kind}:${x.id}:${x.sendingAt}`
            ).slice(0, 16)
          ).toString(),
          enforceNonce: true,
        });

    const remove = await store.change(db => {
      const latest = db[kind][x.id];

      latest.messageId = message.id;
      latest.postChannelId = x.channelId;

      if (latest.status === 'deleted') return true;

      latest.published = true;

      if (latest.version === x.version) {
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

      await store.change(db => {
        db[kind][x.id].messageId = null;
      });
    }
  }

  async function tick() {
    if (ticking || stopping || !client.isReady()) return;
    ticking = true;

    try {
      const current = await store.read();

      if (Object.values(current.matches).some(m =>
        m.status === 'open' && closeAt(m) <= Date.now()
      )) {
        await store.change(s => {
          for (const m of Object.values(s.matches)) {
            if (
              m.status === 'open' &&
              closeAt(m) <= Date.now()
            ) {
              m.status = 'closed';
              m.dirty = true;
              m.version++;
            }
          }
        });
      }

      const s = await store.read();

      for (const kind of ['programs', 'matches']) {
        const items = Object.values(s[kind])
          .sort((a, b) => a.publishAt - b.publishAt);

        for (const x of items) {
          try {
            await syncStaff(x, kind);
          } catch (e) {
            log(`Fiche staff ${x.id}`, e);
          }

          try {
            await publish(x, kind, s);
          } catch (e) {
            log(`Publication ${x.id}`, e);
          }
        }
      }
    } catch (e) {
      log('Programmation', e);
    } finally {
      ticking = false;
    }
  }

  async function ask(i, data) {
    const token = uid();

    await store.change(s => {
      s.pending[token] = {
        ...data,
        uid: i.user.id,
        expires: Date.now() + 900000,
      };
    });

    return i.editReply({
      content: data.kind === 'reset'
        ? '⚠️ Archiver tous les matchs, programmes, points et boosts, puis repartir de zéro ?'
        : data.table === 'programs'
          ? '⚠️ Supprimer cette annonce ? Les matchs et les pronostics seront conservés.'
          : '⚠️ Supprimer ce MatchDay ? Ses points seront retirés des classements. Une copie sera archivée.',
      embeds: [],
      components: [
        row(
          button(`md:yes:${token}`, 'Confirmer', ButtonStyle.Danger),
          button(`md:no:${token}`, 'Annuler')
        ),
      ],
    });
  }

  async function slash(i) {
    need(
      i.guildId === guildId,
      'Utilise cette commande sur le serveur configuré.'
    );

    const name = i.commandName;

    if (name !== 'classement') admin(i);

    await i.deferReply({
      flags: name === 'classement' && !i.options.getBoolean('prive')
        ? undefined
        : MessageFlags.Ephemeral,
    });

    if (name === 'create-match' || name === 'edit-match') {
      const o = i.options;
      const editing = name === 'edit-match';
      const state = await store.read();

      const old = editing
        ? getMatch(state, o.getString('match_id'))
        : null;

      const m = old ? copy(old) : {
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

      if (o.getString('titre') !== null) {
        m.title = clean(o.getString('titre'), 180, 'Titre');
      }

      if (o.getString('fermeture')) {
        m.closingTimeUTC = new Date(
          parseTime(o.getString('fermeture'))
        ).toISOString();
      }

      for (const n of [1, 2, 3]) {
        if (o.getString(`choix${n}_label`) !== null) {
          m[`choice${n}Label`] = clean(
            o.getString(`choix${n}_label`),
            180,
            'Choix'
          );
        }

        if (o.getString(`choix${n}_cote`) !== null) {
          m[`choice${n}Odds`] = odds(o.getString(`choix${n}_cote`));
        }
      }

      if (o.getString('publication')) {
        need(
          !old?.published,
          'Le match est déjà publié : son horaire de publication ne peut plus être changé.'
        );

        m.publishAt = parseTime(o.getString('publication'));
      }

      if (o.getChannel('channel')) {
        m.channelId = o.getChannel('channel').id;
      }

      m.channelId ||= i.channelId;

      m.date = o.getString('journee')
        ? dateKey(o.getString('journee'))
        : old?.date || sportDay(closeAt(m));

      if (o.getString('texte') !== null) {
        m.description = o.getString('texte');
      }

      if (o.getString('image') !== null) {
        m.imageUrl = imageURL(o.getString('image'));
      }

      if (o.getRole('notification')) {
        m.roleId = o.getRole('notification').id;
      }

      if (editing && o.getBoolean('retirer_image')) {
        m.imageUrl = '';
        m.imageFile = '';
      }

      if (editing && o.getBoolean('retirer_notification')) {
        m.roleId = null;
      }

      if (editing && o.getBoolean('retirer_texte')) {
        m.description = '';
      }

      need(
        m.publishAt < closeAt(m),
        'La publication doit précéder la fin des mises.'
      );

      if (!old?.published) {
        need(
          closeAt(m) > Date.now() &&
          (!o.getString('publication') || m.publishAt > Date.now()),
          'Choisis des dates futures.'
        );
      }

      if (
        old &&
        (old.status === 'closed' || closeAt(old) <= Date.now())
      ) {
        need(
          closeAt(m) <= closeAt(old),
          'Un match clôturé ne peut pas être rouvert.'
        );

        m.status = 'closed';
      }

      const changedChoices = old && [1, 2, 3].some(n =>
        m[`choice${n}Label`] !== old[`choice${n}Label`] ||
        m[`choice${n}Odds`] !== old[`choice${n}Odds`]
      );

      const sensitive =
        changedChoices || old && m.date !== old.date;

      matchCard(m);
      await channel(m.channelId);

      if (!old || m.imageUrl !== old.imageUrl) {
        await cacheImage(m, store.dir);
      }

      await store.change(s => {
        if (old) {
          const latest = getMatch(s, m.id);

          need(
            latest.version === old.version,
            'Le match a changé. Recommence.'
          );

          need(
            !sensitive || !Object.keys(s.bets[m.id] || {}).length,
            'Des pronostics existent : les choix, cotes et la journée ne peuvent plus être remplacés.'
          );

          Object.assign(m, {
            published: latest.published,
            status: latest.status === 'scheduled' && m.status === 'closed'
              ? 'closed'
              : latest.status,
            messageId: latest.messageId,
            postChannelId: latest.postChannelId,
            sendingAt: latest.sendingAt,
            staffMessageId: latest.staffMessageId,
            staffChannelId: latest.staffChannelId,
            staffSendingAt: latest.staffSendingAt,
          });

          if (sensitive) m.revision++;
        }

        m.version++;
        m.dirty = true;
        s.matches[m.id] = m;
        s.bets[m.id] ||= {};
      });

      void tick();

      return i.editReply(
        `✅ MatchDay ${editing ? 'modifié' : 'créé'}.\nID : \`${m.id}\`\nPublication : ${time(m.publishAt)}\nFin des mises : ${time(closeAt(m))}\nJournée sportive : ${m.date}\nSalon : <#${m.channelId}>`
      );
    }

    if (name === 'schedule-week' || name === 'edit-week') {
      const o = i.options;
      const editing = name === 'edit-week';
      const s = await store.read();

      const old = editing
        ? s.programs[o.getString('programme_id')]
        : null;

      need(
        !editing || old && old.status !== 'deleted',
        'Programme introuvable.'
      );

      const start = monday(day(Date.now()));

      const p = old ? copy(old) : {
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
        start,
        end: shift(start, 6),
        blocks: copy(EDITION.blocks),
        roleId: null,
        messageId: null,
      };

      if (o.getString('titre') !== null) {
        p.title = clean(o.getString('titre'), 180, 'Titre');
      }

      if (o.getString('debut')) {
        p.start = dateKey(o.getString('debut'));
      }

      if (o.getString('fin')) {
        p.end = dateKey(o.getString('fin'));
      }

      need(
        Date.parse(p.end + 'T12:00:00Z') -
        Date.parse(p.start + 'T12:00:00Z') <= 6 * 86400000,
        'Le programme doit tenir sur sept jours maximum.'
      );

      for (const key of Object.keys(GROUPS)) {
        if (o.getString(key) !== null) {
          const text = o.getString(key)
            .trim()
            .replace(/[\u2013\u2014]/g, '-');

          p.blocks[key] = /^aucun$/i.test(text) ? '' : text;
        }
      }

      if (o.getChannel('reglement')) {
        p.rulesChannelId = o.getChannel('reglement').id;
      }

      validateProgram(p);

      if (o.getString('publication')) {
        need(
          !old?.published,
          'L’annonce est déjà publiée : modifie son contenu directement avec cette commande.'
        );

        p.publishAt = parseTime(o.getString('publication'));

        need(
          p.publishAt > Date.now(),
          'Choisis une publication future.'
        );
      }

      if (o.getChannel('channel')) {
        p.channelId = o.getChannel('channel').id;
      }

      p.channelId ||= i.channelId;

      if (o.getChannel('salon_matchs')) {
        p.matchesChannelId = o.getChannel('salon_matchs').id;
      }

      p.matchesChannelId ||= p.channelId;

      if (o.getString('texte') !== null) {
        p.description = o.getString('texte');
        p.customText = Boolean(p.description.trim());
      }

      if (o.getString('image') !== null) {
        p.imageUrl = imageURL(o.getString('image'));
      }

      if (o.getRole('notification')) {
        p.roleId = o.getRole('notification').id;
      }

      if (editing && o.getBoolean('retirer_image')) {
        p.imageUrl = '';
        p.imageFile = '';
      }

      if (editing && o.getBoolean('retirer_notification')) {
        p.roleId = null;
      }

      if (editing && o.getBoolean('retirer_texte')) {
        p.description = '';
        p.customText = false;
      }

      const preview = weekCard(s, p);

      need(
        preview.embeds[0].length <= 6000,
        'Le programme est trop long pour Discord : raccourcis le texte ou les affiches.'
      );

      await channel(p.channelId);
      await channel(p.matchesChannelId);

      if (!old || p.imageUrl !== old.imageUrl) {
        await cacheImage(p, store.dir);
      }

      await store.change(s => {
        if (old) {
          const latest = s.programs[p.id];

          need(
            latest.version === old.version,
            'Le programme a changé. Recommence.'
          );

          Object.assign(p, {
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

        p.version++;
        p.dirty = true;
        s.programs[p.id] = p;
      });

      void tick();

      return i.editReply(
        `✅ Programme ${editing ? 'modifié' : 'créé'}.\nID : \`${p.id}\`\nDu ${p.start} au ${p.end}\nPublication : ${time(p.publishAt)}\nSalon : <#${p.channelId}>\nPour modifier l’annonce : /edit-week.`
      );
    }

    const s = await store.read();

    if (name === 'close-match') {
      const id = i.options.getString('match_id');

      await store.change(s => {
        const m = getMatch(s, id);

        need(
          m.published,
          'Ce match est programmé : utilise /delete-match pour annuler sa publication.'
        );

        m.status = 'closed';
        m.version++;
        m.dirty = true;
      });

      void tick();

      return i.editReply(
        '🔒 Mises fermées. Les pronostics sont conservés.'
      );
    }

    if (name === 'set-result') {
      const id = i.options.getString('match_id');

      const winners = [1, 2, 3].filter(n =>
        i.options.getBoolean(`choix${n}`)
      );

      need(
        i.options.getBoolean('annule') || winners.length,
        'Sélectionne les choix gagnants ou annule:true si aucun choix ne gagne.'
      );

      need(
        !i.options.getBoolean('annule') || !winners.length,
        'Un match annulé ne peut pas avoir de choix gagnant.'
      );

      await store.change(s => {
        const m = getMatch(s, id);

        need(m.published, 'Ce match n’a pas été publié.');

        need(
          Date.now() >= closeAt(m),
          'Attends la fin des mises avant de saisir un résultat.'
        );

        result(s, id, winners);
      });

      void tick();

      return i.editReply(
        '✅ Résultat enregistré. Les points sont recalculés sans doublon, même en cas de correction.'
      );
    }

    if (name === 'delete-match' || name === 'delete-week') {
      const table = name === 'delete-match' ? 'matches' : 'programs';

      const id = i.options.getString(
        table === 'matches' ? 'match_id' : 'programme_id'
      );

      const x = s[table][id];

      need(x && x.status !== 'deleted', 'Élément introuvable.');

      return ask(i, {
        kind: 'delete',
        table,
        id,
        version: x.version,
      });
    }

    if (name === 'reset-scores') {
      return ask(i, {
        kind: 'reset',
        fingerprint: digest({
          matches: s.matches,
          bets: s.bets,
          programs: s.programs,
        }),
      });
    }

    if (name === 'classement') {
      return i.editReply(rankCard(s, rangeOptions(i.options)));
    }

    if (name === 'list-matches') {
      const date = i.options.getString('semaine');
      const start = date ? monday(dateKey(date)) : null;

      const items = Object.values(s.matches)
        .filter(m =>
          m.status !== 'deleted' &&
          (!start || m.date >= start && m.date <= shift(start, 6))
        )
        .sort((a, b) =>
          a.date.localeCompare(b.date) ||
          closeAt(a) - closeAt(b)
        );

      const lines = items.map(m =>
        `${m.date} | ${m.title} | ${m.status}\nID: ${m.id}\nPublication: ${time(m.publishAt)} | Fermeture: ${time(closeAt(m))}\n`
      );

      lines.push(
        '\nPROGRAMMES\n',
        ...Object.values(s.programs)
          .filter(p => p.status !== 'deleted')
          .map(p =>
            `${p.start} au ${p.end} | ${p.title}\nID: ${p.id}\n`
          )
      );

      return i.editReply({
        content:
          `${items.length} MatchDay(s). Les IDs sont aussi disponibles dans le salon staff si configuré.`,
        files: [
          new AttachmentBuilder(
            Buffer.from(lines.join('\n') || 'Aucun match'),
            { name: 'matchdays.txt' }
          ),
        ],
      });
    }

    if (name === 'diagnostic') {
      return i.editReply(
        `✅ Stockage : ${store.file}\n🕒 Fuseau : ${TZ}\n⚡ Journée du boost : de midi à midi (${TZ})\n📅 ${Object.values(s.matches).filter(m => !m.published && m.status !== 'deleted' && !m.missed).length} matchs à publier\n📣 ${Object.values(s.programs).filter(p => !p.published && p.status !== 'deleted').length} programmes à publier\n🏆 Aucun classement automatique\n💀 Unité : ${UNIT}`
      );
    }

    if (name === 'export') {
      const r = rangeOptions(i.options);
      const values = rank(s, r);

      const rows = [[
        'match_id',
        'journee',
        'titre',
        'discord_id',
        'pseudo',
        'choix',
        'boost',
        'points',
        'resultat',
      ]];

      for (const m of Object.values(s.matches)) {
        if (
          m.status === 'deleted' ||
          r.start && m.date < r.start ||
          r.end && m.date > r.end
        ) continue;

        for (const [id, b] of Object.entries(s.bets[m.id] || {})) {
          if (b.revision === m.revision) {
            rows.push([
              m.id,
              m.date,
              m.title,
              id,
              b.username,
              m[`choice${b.choice}Label`],
              b.boosted ? 'oui' : 'non',
              earned(m, b),
              m.result === null
                ? 'en attente'
                : m.result.join(',') || 'annulé',
            ]);
          }
        }
      }

      const csv = v =>
        `"${String(v ?? '')
          .replaceAll('"', '""')
          .replace(/^[=+\-@]/, "'$&")}"`;

      const file = (rows, name) =>
        new AttachmentBuilder(
          Buffer.from(
            '\uFEFF' +
            rows.map(r => r.map(csv).join(';')).join('\r\n')
          ),
          { name }
        );

      return i.editReply({
        content: `Export ${r.label}`,
        files: [
          file(rows, 'pronostics.csv'),
          file([
            ['rang', 'discord_id', 'pseudo', 'points'],
            ...values.map((u, n) => [
              n + 1,
              u.id,
              u.name,
              u.points,
            ]),
          ], 'classement.csv'),
        ],
      });
    }
  }

  async function buttons(i) {
    need(i.guildId === guildId, 'Serveur invalide.');

    const privateMessage = i.message.flags.has(
      MessageFlags.Ephemeral
    );

    if (privateMessage) {
      await i.deferUpdate();
    } else {
      await i.deferReply({
        flags: MessageFlags.Ephemeral,
      });
    }

    let [
      ,
      action,
      mid,
      value,
      revision,
      finalRevision,
    ] = i.customId.split(':');

    if (i.customId.startsWith('bet_')) {
      const a = i.customId.split('_');
      action = 'bet';
      value = a.pop();
      mid = a.slice(1).join('_');
    }

    if (i.customId.startsWith('confirm_')) {
      const a = i.customId.split('_');
      action = 'confirm';
      revision = a.pop();
      value = a.pop();
      mid = a.slice(1).join('_');
    }

    if (i.customId === 'cancel_bet') {
      action = 'cancel';
    }

    if (action === 'cancel') {
      return i.editReply({
        content: 'Choix annulé.',
        embeds: [],
        components: [],
      });
    }

    if (action === 'yes' || action === 'no') {
      admin(i);

      await store.change(s => {
        const p = s.pending[mid];

        need(
          p && p.uid === i.user.id && p.expires > Date.now(),
          'Confirmation expirée. Recommence.'
        );

        if (action === 'yes') {
          if (p.kind === 'reset') {
            need(
              p.fingerprint === digest({
                matches: s.matches,
                bets: s.bets,
                programs: s.programs,
              }),
              'Des données ont changé. Relance /reset-scores.'
            );

            s.archives.push({
              at: Date.now(),
              kind: 'reset',
              matches: copy(s.matches),
              bets: copy(s.bets),
              users: copy(s.users),
              programs: copy(s.programs),
              boosts: copy(s.boosts),
            });

            for (const table of ['matches', 'programs']) {
              for (const x of Object.values(s[table])) {
                x.status = 'deleted';
                x.version++;
              }
            }

            s.users = {};
            s.bets = {};
            s.boosts = {};
          } else {
            const x = s[p.table][p.id];

            need(
              x && x.version === p.version,
              'Cet élément a changé. Recommence.'
            );

            s.archives.push({
              at: Date.now(),
              kind: 'delete',
              table: p.table,
              data: copy(x),
              bets: p.table === 'matches'
                ? copy(s.bets[x.id] || {})
                : undefined,
            });

            x.status = 'deleted';
            x.version++;
            x.dirty = true;

            for (const u of Object.values(s.users)) {
              u.totalPoints = 0;
            }

            for (const r of rank(s)) {
              if (s.users[r.id]) {
                s.users[r.id].totalPoints = r.points;
              }
            }
          }
        }

        delete s.pending[mid];
      });

      void tick();

      return i.editReply({
        content: action === 'yes'
          ? '✅ Opération confirmée.'
          : 'Opération annulée.',
        embeds: [],
        components: [],
      });
    }

    const s = await store.read();

    if (action === 'week') {
      const p = s.programs[mid];

      need(
        p && p.published && p.status !== 'deleted',
        'Programme indisponible.'
      );

      return i.editReply(weekCard(s, p, value));
    }

    if (action === 'rank') {
      const r = mid === 'all'
        ? { label: 'général' }
        : {
            start: mid,
            end: value,
            label: `du ${mid} au ${value}`,
          };

      return i.editReply(rankCard(s, r, revision));
    }

    const m = getMatch(s, mid);

    // Seul le bouton Mon choix affiche le pronostic déjà validé.
    if (action === 'my') {
      return i.editReply(myCard(s, m, i.user.id));
    }

    // Nouveau clic sur un choix après validation.
    if (s.bets[mid]?.[i.user.id]) {
      return i.editReply({
        content:
          '✅ Ton pronostic est déjà enregistré. Pour le consulter, appuie sur « 📋 Mon choix ».',
        embeds: [],
        components: [],
        allowedMentions: quiet,
      });
    }

    need(isOpen(m), 'Les mises sont fermées.');

    const n = Number(value);
    need(BASE[n], 'Choix invalide.');

    if (action === 'bet') {
      need(
        !revision || Number(revision) === m.revision,
        'Le match a changé. Utilise son message actualisé.'
      );

      const boost = boostAvailable(s, i.user.id);

      const e = embed('Confirme ton pronostic')
        .setDescription([
          `**${safe(m.title)}**`,
          '',
          `${EMOJIS[n]} **${safe(m['choice' + n + 'Label'])}**`,
          '',
          `${ICON} **${BASE[n]} ${UNIT}** si ton choix est gagnant.`,
          '',
          boost
            ? `⚡ Avec le boost x2 : **${BASE[n] * 2} ${UNIT}**.`
            : 'Ton boost de cette journée est déjà utilisé.',
          '',
          'Une fois confirmé, ton pronostic ne peut plus être modifié.',
        ].join('\n'));

      const choices = [
        button(
          `md:confirm:${mid}:${n}:0:${m.revision}`,
          '✅ Confirmer',
          ButtonStyle.Success
        ),
      ];

      if (boost) {
        choices.push(
          button(
            `md:confirm:${mid}:${n}:1:${m.revision}`,
            '⚡ Confirmer + Boost x2',
            ButtonStyle.Primary
          )
        );
      }

      choices.push(
        button('md:cancel', 'Annuler')
      );

      return i.editReply({
        content: '',
        embeds: [e],
        components: [row(...choices)],
      });
    }

    if (action === 'confirm') {
      await store.change(s => place(
        s,
        mid,
        i.user.id,
        n,
        revision === '1',
        Number(finalRevision || m.revision),
        i.user.username
      ));

      const latest = await store.read();

      return i.editReply(
        myCard(latest, getMatch(latest, mid), i.user.id)
      );
    }
  }

  client.on(Events.InteractionCreate, async i => {
    if (stopping) return;

    const isCommand =
      i.isChatInputCommand() &&
      commands.some(c => c.name === i.commandName);

    const isButton =
      i.isButton() &&
      /^(md:|bet_|confirm_|cancel_bet$)/.test(i.customId);

    if (!isCommand && !isButton) return;

    try {
      if (i.isChatInputCommand()) {
        await slash(i);
      } else {
        await buttons(i);
      }
    } catch (e) {
      if (!(e instanceof UserError)) {
        log('Interaction', e);
      }

      const payload = {
        content: e instanceof UserError
          ? `⚠️ ${e.message}`
          : 'Une erreur est survenue. Consulte les logs du bot.',
        allowedMentions: quiet,
      };

      try {
        if (i.deferred || i.replied) {
          if (i.isButton() || i.ephemeral) {
            await i.editReply({
              ...payload,
              embeds: [],
              components: [],
            });
          } else {
            await i.followUp({
              ...payload,
              flags: MessageFlags.Ephemeral,
            });
          }
        } else {
          await i.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (e) {
        log('Réponse erreur', e);
      }
    }
  });

  client.on(Events.Error, e => log('Discord', e));

  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);

      if (staffId) await channel(staffId);

      for (const c of commands) {
        await guild.commands.create(c.toJSON());
      }

      const globals = await client.application.commands.fetch();

      for (const c of globals.values()) {
        if (commands.some(x => x.name === c.name)) {
          await client.application.commands.delete(c.id);
        }
      }

      console.log(
        `MatchDay prêt : ${client.user.tag}. Fuseau : ${TZ}. Stockage : ${store.file}.`
      );

      await tick();

      timer = setInterval(
        () => void tick(),
        15000
      );
    } catch (e) {
      log('Initialisation', e);
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

  process.once('uncaughtException', e => {
    log('Erreur fatale', e);
    void stop(1);
  });

  process.once('unhandledRejection', e => {
    log('Erreur fatale', e);
    void stop(1);
  });

  await client.login(env.DISCORD_TOKEN);
}

if (
  require.main === module ||
  process.env.MATCHDAY_ENTRYPOINT === 'src'
) {
  run().catch(e => {
    console.error(
      `Démarrage : ${e instanceof UserError ? e.message : e.code || e.name}`
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
