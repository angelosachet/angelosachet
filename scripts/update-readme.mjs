#!/usr/bin/env node
/**
 * Atualiza o bloco dos albuns mais ouvidos da semana no README.
 *
 * Ranking: agregado dos scrobbles do Last.fm na janela de WINDOW_DAYS dias
 * (user.getrecenttracks), agrupado por album. Nao usamos
 * user.getweeklyalbumchart/getweeklytrackchart: a agregacao semanal do Last.fm
 * atrasa semanas e devolve 0 itens para a semana corrente e para as
 * recem-encerradas, enquanto getrecenttracks esta sempre em dia.
 *
 * Capa + link do album: Spotify Search (client_credentials). Opcional: sem as
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
const LIMIT = Number(process.env.ALBUM_LIMIT || 6);
const PER_ROW = Number(process.env.ALBUMS_PER_ROW || 3);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);
const MAX_PAGES = Number(process.env.MAX_PAGES || 10);
// Identidade visual do README: verde de destaque sobre fundo quase preto.
const ACCENT = process.env.ACCENT || '7FBF6F';
const INK = process.env.INK || '0a0a0a';
const SECTION_HEADING = process.env.SECTION_HEADING || '02 · som';
const START = '<!-- SPOTIFY-WEEKLY:START -->';
const END = '<!-- SPOTIFY-WEEKLY:END -->';
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

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

/** Agrega os scrobbles da janela por album, ordenado por plays. */
async function topAlbums() {
  const from = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 3600;
  const albums = new Map();
  let scrobbles = 0;
  let semAlbum = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await lastfm('user.getrecenttracks', {
      from: String(from),
      limit: '200',
      page: String(page),
    });
    const rt = data?.recenttracks;
    const raw = rt?.track ?? [];
    const tracks = Array.isArray(raw) ? raw : [raw];

    for (const t of tracks) {
      if (t['@attr']?.nowplaying === 'true') continue; // ainda tocando, nao e scrobble
      scrobbles++;

      const album = t.album?.['#text']?.trim();
      const artist = t.artist?.['#text'] ?? t.artist?.name ?? '';
      if (!album) {
        semAlbum++; // single/podcast sem album: nao rende capa, fica fora do grid
        continue;
      }

      const key = `${artist} — ${album}`.toLowerCase();
      const entry = albums.get(key) ?? {
        album,
        artist,
        plays: 0,
        tracks: new Set(),
        lastPlayed: 0,
      };
      entry.plays++;
      entry.tracks.add(t.name);
      entry.lastPlayed = Math.max(entry.lastPlayed, Number(t.date?.uts || 0));
      albums.set(key, entry);
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

  console.log(
    `${scrobbles} scrobble(s) em ${WINDOW_DAYS} dias, ${albums.size} album(ns)` +
      (semAlbum ? `, ${semAlbum} sem album (ignorado)` : ''),
  );

  // Empate vai para o que ouvi mais recentemente. Ordenar por nome faria uma
  // semana sem repeticoes virar uma lista alfabetica disfarcada de ranking.
  return [...albums.values()]
    .map((a) => ({ ...a, distinct: a.tracks.size }))
    .sort((a, b) => b.plays - a.plays || b.lastPlayed - a.lastPlayed);
}

async function spotifyToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return null;
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

/** Procura o album no Spotify; tenta busca estruturada e depois texto livre. */
async function spotifyLookup(token, { album, artist }) {
  if (!token) return {};
  const queries = [`album:"${album}" artist:"${artist}"`, `${album} ${artist}`];

  for (const q of queries) {
    const qs = new URLSearchParams({ q, type: 'album', limit: '1' });
    try {
      const data = await json(`https://api.spotify.com/v1/search?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const item = data?.albums?.items?.[0];
      if (!item) continue;
      const images = item.images ?? [];
      return {
        url: item.external_urls?.spotify,
        cover: (images.find((i) => i.width && i.width <= 400) ?? images.at(-1))?.url,
      };
    } catch (err) {
      console.warn(`aviso: busca no Spotify falhou para "${album}": ${err.message}`);
      return {};
    }
  }
  console.warn(`aviso: "${album}" - ${artist} nao encontrado no Spotify`);
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
 * "4 faixas" quando ouvi o disco sem repetir nada (o caso comum aqui);
 * "7 plays" quando houve repeticao, porque ai faixas != plays.
 */
const metricLabel = ({ plays, distinct }) =>
  plays === distinct ? `${plays} ${plays === 1 ? 'faixa' : 'faixas'}` : `${plays} plays`;

/** Badge no mesmo idioma visual dos outros do README (flat-square + labelColor). */
const metricBadge = (item) =>
  `https://img.shields.io/badge/${encodeURIComponent(metricLabel(item))}-${ACCENT}?style=flat-square&labelColor=${INK}`;

function cell(item, width) {
  const label = `${esc(item.album)} - ${esc(item.artist)}`;
  const art = `<img src="${esc(item.cover || FALLBACK_COVER)}" width="150" alt="${label}" />`;
  const cover = item.url ? `<a href="${esc(item.url)}">${art}</a>` : art;
  const title = item.url
    ? `<a href="${esc(item.url)}"><b>${esc(item.album)}</b></a>`
    : `<b>${esc(item.album)}</b>`;

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

  const janela = WINDOW_DAYS === 7 ? 'nos últimos 7 dias' : `nos últimos ${WINDOW_DAYS} dias`;
  const stamp = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const lastfmUrl = `https://www.last.fm/user/${encodeURIComponent(LASTFM_USER)}`;
  const profileBadge = SPOTIFY_PROFILE_URL
    ? [
        '',
        `<a href="${esc(SPOTIFY_PROFILE_URL)}">`,
        `  <img src="https://img.shields.io/badge/SPOTIFY-${ACCENT}?style=for-the-badge&logo=spotify&logoColor=${INK}" alt="Meu perfil no Spotify" />`,
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
    `<sub>Os discos que mais rodaram ${janela}. Atualiza sozinho, direto do que eu ouço.</sub>`,
    ...profileBadge,
    '',
    '<br/>',
    '',
    '<table>',
    ...rows,
    '</table>',
    '',
    `<sub>Ranking do <a href="${lastfmUrl}">Last.fm</a>${
      hasSpotify ? ' · capas e links do Spotify' : ''
    } · atualizado em ${stamp}</sub>`,
    '',
    '</div>',
    '',
    END,
  ].join('\n');
}

async function main() {
  const albums = await topAlbums();
  if (!albums.length) fail(`nenhum album nos ultimos ${WINDOW_DAYS} dias, nada a atualizar`);

  const token = await spotifyToken();
  const enriched = [];
  for (const a of albums.slice(0, LIMIT)) {
    enriched.push({ ...a, ...(await spotifyLookup(token, a)) });
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
  console.log(`README atualizado com ${enriched.length} album(ns)`);
}

main().catch((err) => fail(err.stack ?? err.message));
