const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const PORT = 7001;
const BASE = "https://pifansubs.club";
const TMDB_KEY = "1587e42b775d238f0cd0615731a9c004";

const manifest = {
  id: "br.pifansubs.stremio",
  version: "2.0.0",
  name: "PiFansubs",
  description: "BLs legendados em PT-BR pela PiFansubs",
  logo: "https://pifansubs.club/wp-content/uploads/2023/05/ASasassasasas.png",
  resources: ["catalog", "meta", "stream"],
  types: ["series", "movie"],
  catalogs: [
    {
      id: "pifansubs-series",
      type: "series",
      name: "PiFansubs - Séries",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
      extraSupported: ["search", "skip"],
    },
    {
      id: "pifansubs-movies",
      type: "movie",
      name: "PiFansubs - Filmes",
      extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }],
      extraSupported: ["search", "skip"],
    },
  ],
  // "tt" faz o Stremio chamar este addon para streams do Cinemeta
  idPrefixes: ["tt", "pifansubs:"],
};

const builder = new addonBuilder(manifest);

// ─── Cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
function getCache(key) { return cache.get(key) ?? null; }
function setCache(key, value, ttlMs = 30 * 60 * 1000) {
  cache.set(key, value);
  setTimeout(() => cache.delete(key), ttlMs);
}

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

async function fetchPage(url) {
  const cached = getCache(`page:${url}`);
  if (cached) return cached;
  const { data } = await axios.get(url, { headers, timeout: 15000 });
  setCache(`page:${url}`, data);
  return data;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────
function parseArticles(html, type) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  function extractItem(el) {
    const $el = $(el);
    if ($el.closest(".widget, .sidebar").length) return;

    const href = $el.find("a[href*='/series-de-tv/'], a[href*='/filmes/']").first().attr("href")
      || $el.closest("a").attr("href") || "";

    if (!href) return;
    if (type === "series" && !href.includes("/series-de-tv/")) return;
    if (type === "movie" && !href.includes("/filmes/")) return;

    const slug = href.split("/").filter(Boolean).pop();
    if (!slug || seen.has(slug)) return;

    const title = $el.find(".title a").first().text().trim()
      || $el.find("h3").first().text().trim()
      || $el.find("img").first().attr("alt") || "";

    const poster = $el.find("img").first().attr("src") || "";
    if (!title) return;
    seen.add(slug);
    items.push({ slug, title, poster, type });
  }

  const resultItems = $(".result-item article");
  if (resultItems.length > 0) {
    resultItems.each((_, el) => extractItem(el));
  } else {
    $("article").each((_, el) => extractItem(el));
  }

  return items;
}

function itemsToMetas(items) {
  return items.map(item => ({
    id: `pifansubs:${item.slug}`,
    type: item.type,
    name: item.title,
    poster: item.poster,
    background: item.poster,
    posterShape: "regular",
  }));
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────
async function tmdbSearch(query, type) {
  const cacheKey = `tmdb:search:${type}:${query}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const tmdbType = type === "movie" ? "movie" : "tv";
    const { data } = await axios.get(`https://api.themoviedb.org/3/search/${tmdbType}`, {
      params: { api_key: TMDB_KEY, query, language: "pt-BR" },
      timeout: 8000,
    });
    const r = data.results?.[0] || null;
    setCache(cacheKey, r, 24 * 60 * 60 * 1000);
    return r;
  } catch { setCache(cacheKey, null, 60 * 60 * 1000); return null; }
}

// Dado um IMDB ID, retorna os títulos (PT e original) para buscar no PiFansubs
async function getTitlesFromImdb(imdbId, type) {
  const cacheKey = `imdb:titles:${imdbId}`;
  const cached = getCache(cacheKey);
  console.log(`[TMDB] getTitles imdbId=${imdbId} cachedType=${typeof cached} cachedVal=${JSON.stringify(cached)} caller=${new Error().stack.split("\n")[2]?.trim()}`);
  // Não usa cache null — sempre tenta a API
  if (cached !== undefined && cached !== null) return cached;
  try {
    const tmdbType = type === "movie" ? "movie" : "tv";
    const { data } = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: { api_key: TMDB_KEY, external_source: "imdb_id" },
      timeout: 8000,
    });
    console.log(`[TMDB] find/${imdbId} keys=${Object.keys(data).join(",")} tv=${data.tv_results?.length} movie=${data.movie_results?.length}`);
    const r = (data[`${tmdbType}_results`] || [])[0];
    if (!r) { setCache(cacheKey, null, 60 * 60 * 1000); return null; }
    const titles = [r.name || r.title, r.original_name || r.original_title].filter(Boolean);
    console.log(`[TMDB] ${imdbId} -> ${titles.join(" / ")}`);
    setCache(cacheKey, titles, 7 * 24 * 60 * 60 * 1000);
    return titles;
  } catch (e) {
    console.warn(`[TMDB] Erro ${imdbId}: ${e.message} | status=${e.response?.status} | data=${JSON.stringify(e.response?.data).slice(0,100)}`);
    setCache(cacheKey, null, 60 * 60 * 1000);
    return null;
  }
}

// ─── PiFansubs: encontra slug pelo título ─────────────────────────────────────
async function findSlugByTitles(titles, type) {
  for (const title of titles) {
    const cacheKey = `pifan:slug:${type}:${title}`;
    const cached = getCache(cacheKey);
    if (cached !== undefined && cached !== null) return cached;
    try {
      console.log(`[PIFAN] Buscando: "${title}" type=${type}`);
      const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(title)}`);
      const items = parseArticles(html, type);
      console.log(`[PIFAN] Resultados: ${items.map(i => i.slug).join(", ") || "nenhum"}`);
      if (items.length > 0) {
        console.log(`[PIFAN] OK: ${items[0].slug}`);
        setCache(cacheKey, items[0].slug, 24 * 60 * 60 * 1000);
        return items[0].slug;
      }
      setCache(cacheKey, null, 60 * 60 * 1000);
    } catch (e) {
      console.warn(`[PIFAN] Erro "${title}": ${e.message}`);
    }
  }
  return null;
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
async function fetchCatalog(type, search = null, skip = 0) {
  if (search) {
    const cacheKey = `catalog:search:${type}:${search}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;
    console.log(`[CATALOG] Busca: "${search}" type=${type}`);
    const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(search)}`);
    const items = parseArticles(html, type);
    console.log(`[CATALOG] Busca retornou ${items.length} items`);
    const metas = itemsToMetas(items);
    setCache(cacheKey, metas, 10 * 60 * 1000);
    return metas;
  }
  const page = Math.floor(skip / 30) + 1;
  const cacheKey = `catalog:${type}:page:${page}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const base = type === "series" ? `${BASE}/series-de-tv/` : `${BASE}/filmes/`;
  const url = page === 1 ? base : `${base}page/${page}/`;
  console.log(`[CATALOG] Pagina ${page}: ${url}`);
  const html = await fetchPage(url);
  const items = parseArticles(html, type);
  console.log(`[CATALOG] Pagina ${page} retornou ${items.length} items`);
  const metas = itemsToMetas(items);
  setCache(cacheKey, metas, 30 * 60 * 1000);
  return metas;
}

// ─── Detail ───────────────────────────────────────────────────────────────────
async function fetchDetail(slug, type) {
  const cacheKey = `detail:${slug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;
  const section = type === "series" ? "series-de-tv" : "filmes";
  const html = await fetchPage(`${BASE}/${section}/${slug}/`);
  const $ = cheerio.load(html);
  const title = $("h1").first().text().trim();
  const poster = $("meta[property='og:image']").attr("content") || "";
  const description = $(".sinopsis p, .wp-content p").first().text().trim() || "";
  const episodes = [];
  $("ul.episodios li").each((_, el) => {
    const epLink = $(el).find(".episodiotitle a").attr("href") || "";
    const epTitle = $(el).find(".episodiotitle a").text().trim();
    const epNum = $(el).find(".numerando").text().trim();
    if (epLink.includes("/episodios/")) {
      const epSlug = epLink.split("/").filter(Boolean).pop();
      episodes.push({ slug: epSlug, title: epTitle, num: epNum });
    }
  });
  console.log(`[META] ${episodes.length} episodios em "${title}"`);
  const detail = { title, poster, description, episodes, slug, type };
  setCache(cacheKey, detail, 60 * 60 * 1000);
  return detail;
}

// ─── CineBL AES-256-GCM ───────────────────────────────────────────────────────
function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? 0 : 4 - (b64.length % 4);
  return Buffer.from(b64 + "=".repeat(pad), "base64");
}
function joinKeyParts(parts) { return Buffer.concat(parts.map(b64urlToBuffer)); }
function decryptAesGcm(key, iv, payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(payload.slice(-16));
  return Buffer.concat([decipher.update(payload.slice(0, -16)), decipher.final()]);
}

async function fetchByseStream(hostname, videoId, episodeUrl) {
  const cineblHeaders = {
    ...headers,
    "X-Embed-Origin": "pifansubs.club",
    "X-Embed-Referer": episodeUrl,
    "Content-Type": "application/json",
    "Referer": `${BASE}/`,
    "Origin": BASE,
  };
  console.log(`[STREAM] Byse POST: ${hostname} id=${videoId}`);
  const { data } = await axios.post(
    `https://${hostname}/api/videos/${videoId}/embed/playback`,
    {},
    { headers: cineblHeaders, timeout: 12000 }
  );
  const pb = data?.playback;
  if (!pb?.key_parts || !pb?.iv || !pb?.payload) {
    console.log(`[STREAM] Byse (${hostname}): sem key_parts. Resposta: ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  const decrypted = JSON.parse(
    decryptAesGcm(joinKeyParts(pb.key_parts), b64urlToBuffer(pb.iv), b64urlToBuffer(pb.payload))
    .toString("utf8")
  );
  const sources = decrypted?.sources || [];
  if (sources.length === 0) return null;
  const src = sources.find(s => s.url?.includes(".m3u8")) || sources[0];
  console.log(`[STREAM] Byse (${hostname}) ✅: ${src.url}`);
  return { url: src.url, type: src.url?.includes(".m3u8") ? "m3u8" : "mp4" };
}

// Mantém alias para compatibilidade
async function fetchCineBLStream(embedId, episodeUrl) {
  return fetchByseStream("cinebl.com", embedId, episodeUrl);
}

// ─── Stream ───────────────────────────────────────────────────────────────────

// Detecta o tipo de embed_url para facilitar debug
function detectPlayerType(embedUrl) {
  if (!embedUrl) return "none";
  if (embedUrl.includes("cinebl.com")) return "byse";
  if (embedUrl.includes("filemoon.in") || embedUrl.includes("filemoon.sx")) return "byse";
  if (embedUrl.includes("jmvstream.com")) return "jmvstream";
  if (embedUrl.includes("secvideo1.online") || embedUrl.includes("csst.online") || embedUrl.includes("fsst.online")) return "secvideo";
  if (embedUrl.includes("youtube.com") || embedUrl.includes("youtu.be")) return "youtube";
  if (embedUrl.includes("drive.google.com")) return "gdrive";
  if (embedUrl.includes("rumble.com")) return "rumble";
  if (embedUrl.includes("ok.ru")) return "okru";
  if (embedUrl.includes("streamtape")) return "streamtape";
  if (embedUrl.includes("dood")) return "doodstream";
  return `desconhecido(${new URL(embedUrl).hostname})`;
}

async function fetchStream(episodeSlug) {
  const cacheKey = `stream:${episodeSlug}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const url = `${BASE}/episodios/${episodeSlug}/`;
  const { data: html } = await axios.get(url, {
    headers: { ...headers, "Referer": BASE },
    timeout: 15000,
  });

  // Caso 1: JWPlayer direto (Rumble/MP4)
  const sourceMatch = html.match(/jwplayer\/\?source=([^&"'<\s]+)/);
  if (sourceMatch) {
    const result = { url: decodeURIComponent(sourceMatch[1]), type: "mp4" };
    console.log(`[STREAM] ✅ Direto MP4: ${result.url.slice(0, 80)}`);
    setCache(cacheKey, result, 4 * 60 * 60 * 1000);
    return result;
  }

  // Caso 2: AJAX DooPlay
  const postIdMatch = html.match(/data-post='(\d+)'/);
  const numeMatch = html.match(/data-nume='(\d+)'/);

  if (!postIdMatch || !numeMatch) {
    // Sem player reconhecível — loga o HTML para diagnóstico
    const bodySnippet = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500);
    console.error(`[STREAM] ❌ Sem player em ${episodeSlug}. Body: ${bodySnippet}`);
    throw new Error(`Sem player reconhecido: ${episodeSlug}`);
  }

  const postId = postIdMatch[1];
  // Pega TODAS as opções de player disponíveis (Opção 1, Opção 2...)
  const numeOptions = [...html.matchAll(/data-nume='(\d+)'/g)].map(m => m[1]);
  console.log(`[STREAM] AJAX postId=${postId} opções=${numeOptions.join(",")}`);

  for (const nume of numeOptions) {
    try {
      const { data } = await axios.post(
        `${BASE}/wp-admin/admin-ajax.php`,
        new URLSearchParams({ action: "doo_player_ajax", post: postId, nume, type: "tv" }).toString(),
        { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Referer": url }, timeout: 15000 }
      );

      const embedUrl = data.embed_url;
      const playerType = detectPlayerType(embedUrl);
      console.log(`[STREAM] Opção ${nume}: player=${playerType} url=${(embedUrl || "").slice(0, 80)}`);

      if (!embedUrl) continue;

      // Byse Frontend (CineBL, Filemoon — mesma plataforma, mesma API)
      if (playerType === "byse") {
        const byseMatch = embedUrl.match(/\/e\/([a-z0-9]+)/i);
        if (byseMatch) {
          const hostname = new URL(embedUrl).hostname;
          const stream = await fetchByseStream(hostname, byseMatch[1], url);
          if (stream) { setCache(cacheKey, stream, 2 * 60 * 60 * 1000); return stream; }
          console.warn(`[STREAM] Byse (${hostname}) falhou, tentando próxima opção`);
          continue;
        }
      }

      // SecVideo / CSST — MP4 direto no HTML
      if (playerType === "secvideo") {
        // Segue redirect e acessa com Referer
        const { data: svHtml } = await axios.get(embedUrl, {
          headers: { ...headers, "Referer": BASE },
          maxRedirects: 5,
          timeout: 15000,
        });
        const svMp4 = svHtml.match(/file:"(https:\/\/[^"]+\.mp4[^"]*)"/);
        if (svMp4) {
          const result = { url: svMp4[1], type: "mp4" };
          console.log(`[STREAM] ✅ SecVideo MP4: ${result.url.slice(0, 80)}`);
          setCache(cacheKey, result, 4 * 60 * 60 * 1000);
          return result;
        }
        console.warn(`[STREAM] SecVideo sem MP4 em ${embedUrl}`);
        continue;
      }

      // YouTube — não suportado
      if (playerType === "youtube") {
        console.warn(`[STREAM] YouTube não suportado, pulando opção ${nume}`);
        continue;
      }

      // Google Drive — não suportado
      if (playerType === "gdrive") {
        console.warn(`[STREAM] Google Drive não suportado, pulando opção ${nume}`);
        continue;
      }

      // JMVStream / outros: acessa HTML do player e extrai src
      const { data: playerHtml } = await axios.get(embedUrl, {
        headers: { ...headers, "Referer": BASE }, timeout: 15000,
      });

      const m3u8Match = playerHtml.match(/"src":"(https:\/\/[^"]+playlist\.m3u8[^"]+)"/);
      if (m3u8Match) {
        const result = { url: m3u8Match[1].replace(/\\/g, ""), type: "m3u8" };
        console.log(`[STREAM] ✅ M3U8 opção ${nume}: ${result.url.slice(0, 80)}`);
        setCache(cacheKey, result, 4 * 60 * 60 * 1000);
        return result;
      }

      const mp4Match = playerHtml.match(/"src":"(https:\/\/[^"]+\.mp4[^"]*)"/);
      if (mp4Match) {
        const result = { url: mp4Match[1].replace(/\\/g, ""), type: "mp4" };
        console.log(`[STREAM] ✅ MP4 opção ${nume}: ${result.url.slice(0, 80)}`);
        setCache(cacheKey, result, 4 * 60 * 60 * 1000);
        return result;
      }

      // Loga o que veio para debug
      const snippet = playerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
      console.warn(`[STREAM] ⚠️ Player ${playerType} sem src reconhecido. Trecho: ${snippet}`);

    } catch (e) {
      console.error(`[STREAM] Erro na opção ${nume}: ${e.message}`);
    }
  }

  throw new Error(`Nenhuma opção de stream funcionou: ${episodeSlug}`);
}

// Gera variações de título para aumentar chance de match no PiFansubs
function titleVariants(titles) {
  const variants = new Set();
  for (const t of titles) {
    if (!t) continue;
    variants.add(t);
    // Remove subtítulo após ":" ou "-" (ex: "Color Rush: The Tint" → "Color Rush")
    variants.add(t.split(/\s*[:\u2013\u2014]\s*/)[0].trim());
    // Remove artigos e palavras curtas no início
    variants.add(t.replace(/^(the|a|an)\s+/i, "").trim());
  }
  return [...variants].filter(v => v.length > 1);
}

// Resolve o slug do episódio a partir de qualquer formato de ID
async function resolveEpisodeSlug(id, type) {
  console.log(`[RESOLVE] id=${id} type=${type}`);

  // Formato próprio com episódio: pifansubs:slug:ep:epslug
  if (id.includes(":ep:")) {
    return id.split(":ep:")[1];
  }

  // Formato Cinemeta: tt1234567:season:episode
  const ttMatch = id.match(/^(tt\d+):(\d+):(\d+)$/);
  if (ttMatch) {
    const imdbId = ttMatch[1];
    const season = parseInt(ttMatch[2]);
    const episode = parseInt(ttMatch[3]);

    // 1. Busca títulos via TMDB (PT-BR + original)
    const titles = await getTitlesFromImdb(imdbId, type);
    if (!titles) {
      console.log(`[RESOLVE] TMDB nao encontrou ${imdbId}`);
      return null;
    }

    // 2. Busca slug no PiFansubs tentando variações dos títulos
    const variants = titleVariants(titles);
    console.log(`[RESOLVE] Tentando variações: ${variants.join(" | ")}`);
    const slug = await findSlugByTitles(variants, type);
    if (!slug) {
      console.log(`[RESOLVE] PiFansubs nao tem nenhuma variação de: ${titles.join(" / ")}`);
      return null;
    }

    // 3. Pega lista de episódios
    const detail = await fetchDetail(slug, type);
    if (!detail.episodes.length) return null;

    // 4. Encontra episódio pelo padrão SxE no slug (ex: "color-rush-1x2")
    // Os slugs do PiFansubs seguem o padrão "nome-da-serie-SxE"
    const epBySlug = detail.episodes.find(ep => {
      const m = ep.slug.match(/(\d+)x(\d+)$/);
      return m && parseInt(m[1]) === season && parseInt(m[2]) === episode;
    });

    if (epBySlug) {
      console.log(`[RESOLVE] ✅ ${imdbId} S${season}E${episode} -> ${epBySlug.slug}`);
      return epBySlug.slug;
    }

    // Fallback: usa índice linear (episódios em ordem, 1 temporada)
    const ordered = [...detail.episodes].reverse();
    const linearIndex = (season - 1) * 100 + (episode - 1); // assume max 100 eps/temporada
    const epByIndex = ordered[linearIndex] || ordered[episode - 1];

    if (epByIndex) {
      console.log(`[RESOLVE] ✅ (fallback índice) ${imdbId} S${season}E${episode} -> ${epByIndex.slug}`);
      return epByIndex.slug;
    }

    console.log(`[RESOLVE] S${season}E${episode} não encontrado em ${slug} (${detail.episodes.length} eps)`);
    return null;
  }

  return null;
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const skip = parseInt(extra?.skip) || 0;
  console.log(`[CATALOG] type=${type} search="${extra?.search}" skip=${skip}`);
  try {
    const metas = await fetchCatalog(type, extra?.search || null, skip);
    return { metas, hasMore: metas.length >= 30 };
  } catch (e) {
    console.error(`[CATALOG] Erro: ${e.message}`);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[META] type=${type} id=${id}`);
  // Só responde IDs próprios
  if (!id.startsWith("pifansubs:")) return { meta: null };
  try {
    const slug = id.replace("pifansubs:", "").split(":ep:")[0];
    const detail = await fetchDetail(slug, type);
    const tmdb = await tmdbSearch(detail.title, type);
    const videos = detail.episodes.map((ep, i) => ({
      id: `pifansubs:${slug}:ep:${ep.slug}`,
      title: ep.title || `Episodio ${i + 1}`,
      season: 1,
      episode: i + 1,
      released: new Date(0).toISOString(),
    }));
    return {
      meta: {
        id, type,
        name: detail.title,
        poster: tmdb?.poster_path
          ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}`
          : detail.poster,
        background: tmdb?.backdrop_path
          ? `https://image.tmdb.org/t/p/w1280${tmdb.backdrop_path}`
          : detail.poster,
        description: tmdb?.overview || detail.description,
        videos: videos.length > 0 ? videos : undefined,
      },
    };
  } catch (e) {
    console.error(`[META] Erro: ${e.message}`);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[STREAM] id=${id}`);
  try {
    const episodeSlug = await resolveEpisodeSlug(id, type);
    if (!episodeSlug) {
      console.log(`[STREAM] Sem slug para ${id}`);
      return { streams: [] };
    }
    const stream = await fetchStream(episodeSlug);
    return {
      streams: [{
        url: stream.url,
        name: "PiFansubs",
        title: `PT-BR | PiFansubs\n${stream.type.toUpperCase()}`,
        behaviorHints: { notWebReady: stream.type === "m3u8" },
      }],
    };
  } catch (e) {
    console.error(`[STREAM] Erro: ${e.message}`);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`\n✅ PiFansubs addon rodando em http://localhost:${PORT}`);
console.log(`📺 Instale no Stremio: http://localhost:${PORT}/manifest.json\n`);
