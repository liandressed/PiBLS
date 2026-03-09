const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const PORT = process.env.PORT || 7001;
const BASE = "https://pifansubs.club";
const TMDB_KEY = "1587e42b775d238f0cd0615731a9c004";
// URL pública do addon (usada pelo proxy HLS). No Render seta a env var ADDON_URL.
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

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
  if (cached !== undefined) return cached;
  try {
    const tmdbType = type === "movie" ? "movie" : "tv";
    const { data } = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
      params: { api_key: TMDB_KEY, external_source: "imdb_id" },
      timeout: 8000,
    });
    const r = (data[`${tmdbType}_results`] || [])[0];
    if (!r) { setCache(cacheKey, null, 60 * 60 * 1000); return null; }
    const titles = [r.name || r.title, r.original_name || r.original_title].filter(Boolean);
    console.log(`[TMDB] ${imdbId} -> ${titles.join(" / ")}`);
    setCache(cacheKey, titles, 7 * 24 * 60 * 60 * 1000);
    return titles;
  } catch (e) {
    console.warn(`[TMDB] Erro ${imdbId}: ${e.message}`);
    setCache(cacheKey, null, 60 * 60 * 1000);
    return null;
  }
}

// ─── PiFansubs: encontra slug pelo título ─────────────────────────────────────
async function findSlugByTitles(titles, type) {
  for (const title of titles) {
    const cacheKey = `pifan:slug:${type}:${title}`;
    const cached = getCache(cacheKey);
    if (cached !== undefined) return cached;
    try {
      console.log(`[PIFAN] Buscando: "${title}"`);
      const html = await fetchPage(`${BASE}/?s=${encodeURIComponent(title)}`);
      const items = parseArticles(html, type);
      if (items.length > 0) {
        console.log(`[PIFAN] Encontrado: ${items[0].slug}`);
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

// ─── Proxy HLS ───────────────────────────────────────────────────────────────
// Serve o .m3u8 reescrevendo os segmentos para passar pelo addon
// Isso evita bloqueios de CORS/Referer quando o Stremio acessa diretamente
function makeProxyUrl(targetUrl, referer = "") {
  const enc = encodeURIComponent(targetUrl);
  const ref = encodeURIComponent(referer);
  return `${ADDON_URL}/hlsproxy?url=${enc}&ref=${ref}`;
}

async function rewriteM3u8(m3u8Url, referer) {
  const { data: m3u8Text } = await axios.get(m3u8Url, {
    headers: { ...headers, "Referer": referer },
    timeout: 10000,
  });

  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

  // Reescreve cada linha que é URI (segmento ou playlist aninhada)
  const rewritten = m3u8Text.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      // Reescreve URI= dentro de tags como #EXT-X-KEY
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = uri.startsWith("http") ? uri : baseUrl + uri;
        return `URI="${makeProxyUrl(abs, referer)}"`;
      });
    }
    // Linha de segmento ou playlist
    const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
    return makeProxyUrl(abs, referer);
  }).join("\n");

  return rewritten;
}

async function fetchCineBLStream(embedId, episodeUrl) {
  const cineblHeaders = {
    ...headers,
    "X-Embed-Origin": "pifansubs.club",
    "X-Embed-Referer": episodeUrl,
    "Content-Type": "application/json",
    "Referer": `${BASE}/`,
    "Origin": BASE,
  };
  console.log(`[STREAM] CineBL POST: ${embedId}`);
  const { data } = await axios.post(
    `https://cinebl.com/api/videos/${embedId}/embed/playback`,
    {},
    { headers: cineblHeaders, timeout: 12000 }
  );
  const pb = data?.playback;
  if (!pb?.key_parts || !pb?.iv || !pb?.payload) {
    console.log(`[STREAM] CineBL: sem key_parts`);
    return null;
  }
  const decrypted = JSON.parse(
    decryptAesGcm(joinKeyParts(pb.key_parts), b64urlToBuffer(pb.iv), b64urlToBuffer(pb.payload))
    .toString("utf8")
  );
  const sources = decrypted?.sources || [];
  if (sources.length === 0) return null;
  // Prefere MP4 para evitar problemas de proxy; cai no M3U8 se não tiver
  const mp4Src = sources.find(s => s.url?.includes(".mp4") || s.mimeType?.includes("mp4"));
  const m3u8Src = sources.find(s => s.url?.includes(".m3u8") || s.mimeType?.includes("mpegurl"));
  const src = mp4Src || m3u8Src || sources[0];
  const isHls = src.url?.includes(".m3u8");
  console.log(`[STREAM] CineBL OK (${isHls ? "m3u8" : "mp4"}): ${src.url}`);
  return { url: src.url, type: isHls ? "m3u8" : "mp4", referer: BASE };
}

// ─── Stream ───────────────────────────────────────────────────────────────────
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
    console.log(`[STREAM] Direto: ${result.url}`);
    setCache(cacheKey, result, 4 * 60 * 60 * 1000);
    return result;
  }

  // Caso 2: AJAX DooPlay
  const postIdMatch = html.match(/data-post='(\d+)'/);
  const numeMatch = html.match(/data-nume='(\d+)'/);
  if (postIdMatch && numeMatch) {
    const postId = postIdMatch[1];
    const nume = numeMatch[1];
    console.log(`[STREAM] AJAX: postId=${postId} nume=${nume}`);
    const { data } = await axios.post(
      `${BASE}/wp-admin/admin-ajax.php`,
      new URLSearchParams({ action: "doo_player_ajax", post: postId, nume, type: "tv" }).toString(),
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", "Referer": url }, timeout: 15000 }
    );
    console.log(`[STREAM] embed_url: ${JSON.stringify(data).slice(0, 120)}`);
    if (data.embed_url) {
      const cineblMatch = data.embed_url.match(/cinebl\.com\/e\/([a-z0-9]+)/i);
      if (cineblMatch) {
        const stream = await fetchCineBLStream(cineblMatch[1], url);
        if (stream) { setCache(cacheKey, stream, 2 * 60 * 60 * 1000); return stream; }
        throw new Error(`CineBL sem sources: ${cineblMatch[1]}`);
      }
      const { data: playerHtml } = await axios.get(data.embed_url, {
        headers: { ...headers, "Referer": BASE }, timeout: 15000,
      });
      const m3u8Match = playerHtml.match(/"src":"(https:\/\/[^"]+playlist\.m3u8[^"]+)"/);
      if (m3u8Match) {
        const result = { url: m3u8Match[1].replace(/\\/g, ""), type: "m3u8" };
        setCache(cacheKey, result, 4 * 60 * 60 * 1000); return result;
      }
      const mp4Match = playerHtml.match(/"src":"(https:\/\/[^"]+\.mp4[^"]*)"/);
      if (mp4Match) {
        const result = { url: mp4Match[1].replace(/\\/g, ""), type: "mp4" };
        setCache(cacheKey, result, 4 * 60 * 60 * 1000); return result;
      }
    }
  }
  throw new Error(`Stream nao encontrado: ${episodeSlug}`);
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

    // 1. Busca títulos pelo IMDB ID
    const titles = await getTitlesFromImdb(imdbId, type);
    if (!titles) {
      console.log(`[RESOLVE] TMDB nao encontrou ${imdbId}`);
      return null;
    }

    // 2. Busca slug no PiFansubs
    const slug = await findSlugByTitles(titles, type);
    if (!slug) {
      console.log(`[RESOLVE] PiFansubs nao tem: ${titles.join(" / ")}`);
      return null;
    }

    // 3. Pega lista de episódios
    const detail = await fetchDetail(slug, type);
    if (!detail.episodes.length) return null;

    // Episódios do PiFansubs vêm em ordem reversa (mais recente primeiro)
    // Inverte para que índice 0 = episódio 1
    const ordered = [...detail.episodes].reverse();
    const ep = ordered[(season - 1) * ordered.length + (episode - 1)]
            || ordered[episode - 1];

    if (!ep) {
      console.log(`[RESOLVE] S${season}E${episode} nao achado em ${slug} (${detail.episodes.length} eps)`);
      return null;
    }

    console.log(`[RESOLVE] ${imdbId} S${season}E${episode} -> ${ep.slug}`);
    return ep.slug;
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

    // Para M3U8: serve via proxy HLS do addon para evitar bloqueios de Referer
    let streamUrl = stream.url;
    let notWebReady = false;
    if (stream.type === "m3u8") {
      try {
        // Proxy reescreve o m3u8 — Stremio acessa segmentos pelo addon
        streamUrl = makeProxyUrl(stream.url, stream.referer || BASE);
        console.log(`[STREAM] HLS via proxy: ${streamUrl.slice(0, 80)}`);
        notWebReady = false; // proxy serve HTTP normal, Stremio consegue
      } catch (e) {
        console.warn(`[STREAM] Proxy falhou, entregando m3u8 direto: ${e.message}`);
        streamUrl = stream.url;
        notWebReady = true;
      }
    }

    return {
      streams: [{
        url: streamUrl,
        name: "PiFansubs",
        title: `PT-BR | PiFansubs\n${stream.type.toUpperCase()}`,
        behaviorHints: { notWebReady },
      }],
    };
  } catch (e) {
    console.error(`[STREAM] Erro: ${e.message}`);
    return { streams: [] };
  }
});

// ─── Servidor Express com rota de proxy HLS ───────────────────────────────────
const express = require("express");
const app = express();

// Proxy HLS: baixa .m3u8 ou segmento e repassa com headers corretos
app.get("/hlsproxy", async (req, res) => {
  const targetUrl = decodeURIComponent(req.query.url || "");
  const referer   = decodeURIComponent(req.query.ref || BASE);

  if (!targetUrl.startsWith("http")) {
    return res.status(400).send("URL inválida");
  }

  try {
    const isM3u8 = targetUrl.includes(".m3u8") || targetUrl.includes("playlist");
    const response = await axios.get(targetUrl, {
      headers: {
        ...headers,
        "Referer": referer,
        "Origin": new URL(referer).origin,
      },
      responseType: isM3u8 ? "text" : "stream",
      timeout: 15000,
    });

    if (isM3u8) {
      // Reescreve URLs dentro do m3u8 para também passar pelo proxy
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      const rewritten = response.data.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = uri.startsWith("http") ? uri : baseUrl + uri;
            return `URI="${makeProxyUrl(abs, referer)}"`;
          });
        }
        const abs = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
        return makeProxyUrl(abs, referer);
      }).join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.send(rewritten);
    } else {
      // Segmento: repassa o stream binário
      res.setHeader("Content-Type", response.headers["content-type"] || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      response.data.pipe(res);
    }
  } catch (e) {
    console.error(`[PROXY] Erro: ${e.message} url=${targetUrl.slice(0, 80)}`);
    res.status(502).send("Proxy error");
  }
});

// Monta o addon Stremio no mesmo servidor Express
// getInterface() retorna { manifest, query } — usamos o router do SDK
const { getRouter } = require("stremio-addon-sdk");
const addonRouter = getRouter(builder.getInterface());
app.use("/", addonRouter);

app.listen(PORT, () => {
  console.log(`\n✅ PiFansubs addon rodando em http://localhost:${PORT}`);
  console.log(`📺 Instale no Stremio: http://localhost:${PORT}/manifest.json`);
  console.log(`🔗 ADDON_URL=${ADDON_URL}\n`);
});
