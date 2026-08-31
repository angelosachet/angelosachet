#!/usr/bin/env node
/**
 * Atualiza um bloco com o que voce mais ouviu dentro de um README.
 *
 * GROUP_BY=album (padrao) ranqueia albuns; GROUP_BY=track ranqueia faixas.
 * Prefira album se voce ouve disco inteiro sem repetir musica: nesse padrao o
 * ranking de faixas fica todo empatado em 1 play e a ordem passa a ser
 * arbitraria. Prefira track se voce repete as mesmas musicas.
 *
 * Ranking: agregado dos scrobbles do Last.fm na janela de WINDOW_DAYS dias
 * (user.getrecenttracks). Nao usamos user.getweekly{track,album}chart: a
 * agregacao semanal do Last.fm atrasa semanas e devolve 0 itens para a semana
 * corrente e para as recem-encerradas, enquanto getrecenttracks esta em dia.
 *
 * Capa + link: Spotify Search (client_credentials). Opcional: sem as
 * credenciais o grid ainda e gerado, so com placeholder e sem link.
 */

const {
  LASTFM_API_KEY,
  LASTFM_USER,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_PROFILE_URL = '',
} = process.env;

const README = process.env.README_PATH || 'README.md';
const GROUP_BY = String(process.env.GROUP_BY || 'album').toLowerCase() === 'track' ? 'track' : 'album';
const LIMIT = Number(process.env.ITEM_LIMIT || process.env.ALBUM_LIMIT || 6);
const PER_ROW = Number(process.env.ITEMS_PER_ROW || process.env.ALBUMS_PER_ROW || 3);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);
const COVER_SIZE = Number(process.env.COVER_SIZE || 150);
// Paleta do Spotify como padrao; sobrescreva para casar com o seu README.
const ACCENT = process.env.ACCENT || '1DB954';
const INK = process.env.INK || '191414';
// OUTPUT_LANG, e nao LANG: LANG e variavel de ambiente do sistema e viria
// preenchida (pt_BR.UTF-8, C.UTF-8...) sem ninguem ter pedido.
const LANG = String(process.env.OUTPUT_LANG || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt';
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const START = '<!-- SPOTIFY-WEEKLY:START -->';
const END = '<!-- SPOTIFY-WEEKLY:END -->';
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

const TEXT = {
  pt: {
    heading: { album: '🎧 mais ouvidos', track: '🎧 mais tocadas' },
    caption: {
      album: (d) => `Os discos que mais rodaram nos últimos ${d} dias. Atualiza sozinho, direto do que eu ouço.`,
      track: (d) => `As músicas que mais rodaram nos últimos ${d} dias. Atualiza sozinho, direto do que eu ouço.`,
    },
    tracks: (n) => `${n} ${n === 1 ? 'faixa' : 'faixas'}`,
    plays: (n) => `${n} ${n === 1 ? 'play' : 'plays'}`,
    profile: 'Meu perfil no Spotify',
    footer: (lastfm, spotify, stamp) =>
      `Ranking do <a href="${lastfm}">Last.fm</a>${
        spotify ? ' · capas e links do Spotify' : ''
      } · atualizado em ${stamp}`,
    locale: 'pt-BR',
  },
  en: {
    heading: { album: '🎧 on repeat', track: '🎧 most played' },
    caption: {
      album: (d) => `The albums I played the most over the last ${d} days. Updates itself, straight from what I listen to.`,
      track: (d) => `The tracks I played the most over the last ${d} days. Updates itself, straight from what I listen to.`,
    },
    tracks: (n) => `${n} ${n === 1 ? 'track' : 'tracks'}`,
    plays: (n) => `${n} ${n === 1 ? 'play' : 'plays'}`,
    profile: 'My Spotify profile',
    footer: (lastfm, spotify, stamp) =>
      `Ranked from <a href="${lastfm}">Last.fm</a>${
        spotify ? ' · art and links from Spotify' : ''
      } · updated ${stamp}`,
    locale: 'en-US',
  },
}[LANG];

const SECTION_HEADING = process.env.SECTION_HEADING || TEXT.heading[GROUP_BY];

const fail = (msg) => {
  console.error(`erro: ${msg}`);
  process.exit(1);
};

if (!LASTFM_API_KEY) fail('LASTFM_API_KEY nao definida');
if (!LASTFM_USER) fail('LASTFM_USER nao definida');

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} em ${url.split('?')[0]}`);
  return res.json();
}

function lastfm(method, params = {}) {
  const qs = new URLSearchParams({
    method,
    user: LASTFM_USER,
    api_key: LASTFM_API_KEY,
    format: 'json',
    ...params,
  });
  return json(`${LASTFM_API}?${qs}`);
}

/** Baixa os scrobbles da janela, do mais recente para o mais antigo. */
async function scrobbles() {
  const from = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 3600;
  const out = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await lastfm('user.getrecenttracks', {
      from: String(from),
      limit: '200',
      page: String(page),
    });
    const rt = data?.recenttracks;
    const raw = rt?.track ?? [];

    for (const t of Array.isArray(raw) ? raw : [raw]) {
      if (t['@attr']?.nowplaying === 'true') continue; // ainda tocando, nao e scrobble
      out.push({
        track: t.name,
        artist: t.artist?.['#text'] ?? t.artist?.name ?? '',
        album: t.album?.['#text']?.trim() ?? '',
        uts: Number(t.date?.uts || 0),
      });
    }

    const totalPages = Number(rt?.['@attr']?.totalPages || 1);
    if (page >= totalPages) break;
    if (page === MAX_PAGES) {
      // Truncar em silencio enviesaria o ranking para os scrobbles mais
      // recentes da janela, sem nenhum sinal de que isso aconteceu.
      console.warn(
        `aviso: teto de ${MAX_PAGES} paginas atingido (${totalPages} disponiveis); ` +
          `ranking considera so os ${MAX_PAGES * 200} scrobbles mais recentes da janela`,
      );
    }
  }
  return out;
}

/** Agrupa os scrobbles por album ou por faixa, ordenado por plays. */
function rank(plays) {
  const items = new Map();
  let ignorados = 0;

  for (const s of plays) {
    // Sem album nao ha capa para mostrar; no modo faixa a capa vem da busca no
    // Spotify, entao a ausencia aqui nao impede nada.
    if (GROUP_BY === 'album' && !s.album) {
      ignorados++;
      continue;
    }

    const title = GROUP_BY === 'album' ? s.album : s.track;
    const key = `${s.artist} — ${title}`.toLowerCase();
    const entry = items.get(key) ?? {
      title,
      artist: s.artist,
      album: s.album,
      plays: 0,
      tracks: new Set(),
      lastPlayed: 0,
    };
    entry.plays++;
    entry.tracks.add(s.track);
    entry.lastPlayed = Math.max(entry.lastPlayed, s.uts);
    items.set(key, entry);
  }

  console.log(
    `${plays.length} scrobble(s) em ${WINDOW_DAYS} dias, ` +
      `${items.size} ${GROUP_BY === 'album' ? 'album(ns)' : 'faixa(s)'}` +
      (ignorados ? `, ${ignorados} sem album (ignorado)` : ''),
  );

  // Empate vai para o que ouvi mais recentemente. Ordenar por nome faria uma
  // janela sem repeticoes virar uma lista alfabetica disfarcada de ranking.
  return [...items.values()]
    .map((i) => ({ ...i, distinct: i.tracks.size }))
    .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed);
}

async function spotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('sem credenciais do Spotify: grid sai com placeholder e sem link');
    return null;
  }
  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  try {
    const data = await json('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    return data.access_token ?? null;
  } catch (err) {
    console.warn(`aviso: token do Spotify falhou (${err.message}); seguindo sem capas`);
    return null;
  }
}

/** Procura no Spotify; tenta busca estruturada e depois texto livre. */
async function spotifyLookup(token, item) {
  if (!token) return {};
  const field = GROUP_BY === 'album' ? 'album' : 'track';
  const queries = [`${field}:"${item.title}" artist:"${item.artist}"`, `${item.title} ${item.artist}`];

  for (const q of queries) {
    const qs = new URLSearchParams({ q, type: field, limit: '1' });
    try {
      const data = await json(`https://api.spotify.com/v1/search?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const found = GROUP_BY === 'album' ? data?.albums?.items?.[0] : data?.tracks?.items?.[0];
      if (!found) continue;
      const images = (GROUP_BY === 'album' ? found.images : found.album?.images) ?? [];
      return {
        url: found.external_urls?.spotify,
        cover: (images.find((i) => i.width && i.width <= 400) ?? images.at(-1))?.url,
      };
    } catch (err) {
      console.warn(`aviso: busca no Spotify falhou para "${item.title}": ${err.message}`);
      return {};
    }
  }
  console.warn(`aviso: "${item.title}" - ${item.artist} nao encontrado no Spotify`);
  return {};
}

const esc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FALLBACK_COVER = `https://placehold.co/300x300/${INK}/${ACCENT}?text=%E2%99%AA`;

/**
 * No modo album, "4 faixas" quando o disco rodou sem repetir nada (o caso de
 * quem ouve album inteiro) e "7 plays" quando houve repeticao, porque ai os
 * dois numeros divergem. No modo faixa, plays e a unica leitura possivel.
 */
const metricLabel = ({ plays, distinct }) =>
  GROUP_BY === 'album' && plays === distinct ? TEXT.tracks(plays) : TEXT.plays(plays);

/** Badge no mesmo idioma visual dos shields.io usados em READMEs de perfil. */
const metricBadge = (item) =>
  `https://img.shields.io/badge/${encodeURIComponent(metricLabel(item))}-${ACCENT}?style=flat-square&labelColor=${INK}`;

function cell(item, width) {
  const label = `${esc(item.title)} - ${esc(item.artist)}`;
  const art = `<img src="${esc(item.cover || FALLBACK_COVER)}" width="${COVER_SIZE}" alt="${label}" />`;
  const cover = item.url ? `<a href="${esc(item.url)}">${art}</a>` : art;
  const title = item.url
    ? `<a href="${esc(item.url)}"><b>${esc(item.title)}</b></a>`
    : `<b>${esc(item.title)}</b>`;

  return [
    `    <td align="center" width="${width}%" valign="top">`,
    `      ${cover}<br/>`,
    `      ${title}<br/>`,
    `      <sub>${esc(item.artist)}</sub><br/>`,
    `      <img src="${metricBadge(item)}" alt="${metricLabel(item)}" />`,
    '    </td>',
  ].join('\n');
}

function renderGrid(items, { hasSpotify }) {
  const width = Math.floor(100 / PER_ROW);
  const rows = [];

  for (let i = 0; i < items.length; i += PER_ROW) {
    const chunk = items.slice(i, i + PER_ROW);
    rows.push(['  <tr>', ...chunk.map((it) => cell(it, width)), '  </tr>'].join('\n'));
  }

  const stamp = new Date().toLocaleDateString(TEXT.locale, { timeZone: TIMEZONE });
  const lastfmUrl = `https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}`;
  const profileBadge = SPOTIFY_PROFILE_URL
    ? [
        '',
        `<a href="${esc(SPOTIFY_PROFILE_URL)}">`,
        `  <img src="https://img.shields.io/badge/SPOTIFY-${ACCENT}?style=for-the-badge&logo=spotify&logoColor=${INK}" alt="${TEXT.profile}" />`,
        '</a>',
      ]
    : [];

  return [
    START,
    '',
    '<div align="center">',
    '',
    `## \`${SECTION_HEADING}\``,
    '',
    `<sub>${TEXT.caption[GROUP_BY](WINDOW_DAYS)}</sub>`,
    ...profileBadge,
    '',
    '<br/>',
    '',
    '<table>',
    ...rows,
    '</table>',
    '',
    `<sub>${TEXT.footer(lastfmUrl, hasSpotify, stamp)}</sub>`,
    '',
    '</div>',
    '',
    END,
  ].join('\n');
}

async function main() {
  const items = rank(await scrobbles());
  if (!items.length) fail(`nada ouvido nos ultimos ${WINDOW_DAYS} dias, nada a atualizar`);

  const token = await spotifyToken();
  const enriched = [];
  for (const item of items.slice(0, LIMIT)) {
    enriched.push({ ...item, ...(await spotifyLookup(token, item)) });
  }

  const { readFile, writeFile } = await import('node:fs/promises');
  const readme = await readFile(README, 'utf8').catch(() => fail(`nao consegui ler ${README}`));
  const startAt = readme.indexOf(START);
  const endAt = readme.indexOf(END);
  if (startAt === -1 || endAt === -1) {
    fail(`marcadores ausentes em ${README}. Adicione as duas linhas:\n${START}\n${END}`);
  }
  // Par duplicado geraria a secao duas vezes, e so a primeira seria atualizada.
  if (readme.indexOf(START, startAt + 1) !== -1 || readme.indexOf(END, endAt + 1) !== -1) {
    fail(`${README} tem mais de um par de marcadores SPOTIFY-WEEKLY; deixe apenas um`);
  }
  if (endAt < startAt) fail(`em ${README} o marcador END aparece antes do START`);

  const updated =
    readme.slice(0, startAt) +
    renderGrid(enriched, { hasSpotify: Boolean(token) }) +
    readme.slice(endAt + END.length);

  if (updated === readme) {
    console.log('README ja esta atualizado');
    return;
  }
  await writeFile(README, updated);
  console.log(`README atualizado com ${enriched.length} item(ns) [GROUP_BY=${GROUP_BY}]`);
}

main().catch((err) => fail(err.stack ?? err.message));
