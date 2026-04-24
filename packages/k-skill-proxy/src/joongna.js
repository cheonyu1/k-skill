const JOONGNA_WEB_BASE_URL = "https://web.joongna.com";
const DEFAULT_QUANTITY = 20;
const MAX_QUANTITY = 50;
const ALLOWED_SORTS = new Set([
  "RECOMMEND_SORT",
  "RECENT_SORT",
  "PRICE_ASC_SORT",
  "PRICE_DESC_SORT"
]);

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatWon(value) {
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

/**
 * Normalize the query parameters for the Joongna search route.
 */
function normalizeJoongnaSearchQuery(query) {
  const q = trimOrNull(query.q ?? query.query ?? query.keyword ?? query.searchWord);
  if (!q) {
    throw new Error("Provide q/query/keyword.");
  }
  if ([...q].length < 2) {
    throw new Error("q/query must be at least 2 characters.");
  }

  const rawQuantity = parseInteger(query.quantity ?? query.limit ?? query.size, DEFAULT_QUANTITY);
  const rawPage = parseInteger(query.page, 0);
  const requestedSort = trimOrNull(query.sort) || "RECOMMEND_SORT";
  const sort = ALLOWED_SORTS.has(requestedSort) ? requestedSort : "RECOMMEND_SORT";

  const minPrice = parseInteger(query.minPrice, 0);
  const maxPrice = parseInteger(query.maxPrice, 100000000);

  return {
    query: q,
    quantity: clamp(rawQuantity, 1, MAX_QUANTITY),
    firstQuantity: clamp(rawQuantity, 1, MAX_QUANTITY),
    page: Math.max(rawPage, 0),
    sort,
    minPrice: Math.max(minPrice, 0),
    maxPrice: Math.max(maxPrice, minPrice),
    jnPayYn: trimOrNull(query.jnPayYn) || "ALL",
    saleYn: trimOrNull(query.saleYn) || "SALE_N",
    parcelFeeYn: trimOrNull(query.parcelFeeYn) || "ALL",
    registPeriod: trimOrNull(query.registPeriod) || "ALL"
  };
}

/**
 * Extract RSC payload chunks from the Joongna SSR HTML.
 * The search results are embedded in `self.__next_f.push([1,"..."])` script tags.
 */
function extractRscChunks(html) {
  const chunks = [];
  const regex = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    chunks.push(unescapeRscString(match[1]));
  }
  return chunks;
}

/**
 * Unescape RSC payload string literals.
 * Next.js RSC payloads use \n for newlines and \" for quotes.
 */
function unescapeRscString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Find the RSC chunk that contains the search result items.
 */
function findSearchResultChunk(chunks) {
  for (const chunk of chunks) {
    // Each chunk starts with a line number prefix like "23:" followed by JSON
    const colonIdx = chunk.indexOf(":");
    if (colonIdx < 0 || colonIdx > 5) continue;

    const jsonCandidate = chunk.substring(colonIdx + 1);
    if (!jsonCandidate.includes("items") || !jsonCandidate.includes("productPositionNo")) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonCandidate);
      const items = extractItemsFromParsed(parsed);
      if (items && items.length > 0) {
        return items;
      }
    } catch {
      // Try deeper extraction
    }
  }
  return null;
}

/**
 * Walk the parsed RSC object tree to find the items array.
 */
function extractItemsFromParsed(obj, depth = 0) {
  if (depth > 12 || !obj || typeof obj !== "object") return null;

  if (Array.isArray(obj)) {
    // Check if this is the items array directly
    if (obj.length > 0 && obj[0] && typeof obj[0] === "object" && "seq" in obj[0] && "productPositionNo" in obj[0]) {
      return obj;
    }
    for (const item of obj) {
      const result = extractItemsFromParsed(item, depth + 1);
      if (result) return result;
    }
    return null;
  }

  // Direct items property
  if (Array.isArray(obj.items) && obj.items.length > 0 && obj.items[0] && "seq" in obj.items[0]) {
    return obj.items;
  }

  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null) {
      const result = extractItemsFromParsed(value, depth + 1);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Parse raw items from the RSC payload into normalized products.
 */
function normalizeJoongnaItem(item) {
  if (!item || typeof item !== "object") return null;

  const seq = item.seq;
  const title = trimOrNull(item.title);
  const price = typeof item.price === "number" ? item.price : null;

  if (!seq || !title || price === null) return null;

  const locationNames = Array.isArray(item.locationNames) ? item.locationNames : [];
  const mainLocation = trimOrNull(item.mainLocationName) || null;
  const imageUrl = trimOrNull(item.url);
  const wishCount = typeof item.wishCount === "number" ? item.wishCount : null;
  const chatCount = typeof item.chatCount === "number" ? item.chatCount : null;
  const parcelFee = typeof item.parcelFee === "number" ? item.parcelFee : null;
  const jnPayBadge = Boolean(item.jnPayBadgeFlag);
  const sortDate = trimOrNull(item.sortDate);
  const storeSeq = item.storeSeq || null;
  const certifySeller = Boolean(item.certifySellerFlag);
  const state = typeof item.state === "number" ? item.state : null;

  return {
    product_id: seq,
    title,
    price,
    price_text: formatWon(price),
    location: mainLocation,
    locations: locationNames,
    image_url: imageUrl,
    wish_count: wishCount,
    chat_count: chatCount,
    parcel_fee: parcelFee === 1 ? "유료" : parcelFee === 0 ? "무료" : null,
    jn_pay: jnPayBadge,
    certified_seller: certifySeller,
    sort_date: sortDate,
    store_seq: storeSeq,
    state,
    product_url: `https://web.joongna.com/product/${seq}`,
    source: "joongna-rsc"
  };
}

/**
 * Compact an item by removing null/undefined fields.
 */
function compactItem(item) {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    })
  );
}

/**
 * Parse Joongna search results from SSR HTML.
 */
function parseJoongnaSearchHtml(html, { query = null, quantity = DEFAULT_QUANTITY } = {}) {
  const normalizedQuantity = clamp(parseInteger(quantity, DEFAULT_QUANTITY), 1, MAX_QUANTITY);

  const chunks = extractRscChunks(html);
  const rawItems = findSearchResultChunk(chunks);

  if (!rawItems) {
    return {
      items: [],
      meta: {
        query,
        extraction: "none",
        item_count: 0
      }
    };
  }

  const items = rawItems
    .slice(0, normalizedQuantity)
    .map(normalizeJoongnaItem)
    .filter(Boolean)
    .map(compactItem);

  return {
    items,
    total_size: null,
    meta: {
      query,
      extraction: "joongna-rsc",
      item_count: items.length
    }
  };
}

/**
 * Fetch Joongna search results by requesting the SSR page and parsing the RSC payload.
 */
async function fetchJoongnaSearch({ query, quantity, firstQuantity, page, sort, minPrice, maxPrice, jnPayYn, saleYn, parcelFeeYn, registPeriod, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node runtime.");
  }

  const searchUrl = `${JOONGNA_WEB_BASE_URL}/search/${encodeURIComponent(query)}`;

  const response = await fetchImpl(searchUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: JOONGNA_WEB_BASE_URL
    },
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.text();

  if (!response.ok) {
    const error = new Error(`Joongna upstream responded with ${response.status}.`);
    error.code = "upstream_error";
    error.statusCode = 502;
    error.upstreamStatusCode = response.status;
    error.upstreamBodySnippet = body.slice(0, 200);
    throw error;
  }

  const parsed = parseJoongnaSearchHtml(body, { query, quantity });

  return {
    ...parsed,
    upstream: {
      url: searchUrl,
      status_code: response.status,
      content_type: response.headers.get("content-type") || null,
      provider: "joongna-rsc"
    }
  };
}

module.exports = {
  fetchJoongnaSearch,
  normalizeJoongnaSearchQuery,
  parseJoongnaSearchHtml,
  extractRscChunks,
  findSearchResultChunk,
  normalizeJoongnaItem
};
