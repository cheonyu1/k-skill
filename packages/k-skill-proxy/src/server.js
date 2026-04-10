const crypto = require("node:crypto");
const Fastify = require("fastify");
const { fetchFineDustReport } = require("./airkorea");
const { proxyBlueRibbonNearbyRequest } = require("./bluer");
const { fetchWaterLevelReport } = require("./hrfco");
const { fetchTransactions, VALID_ASSET_TYPES, VALID_DEAL_TYPES } = require("./molit");
const { searchRegionCode } = require("./region-lookup");
const { resolveEducationOfficeFromNaturalLanguage } = require("./neis-office-codes");
const AIR_KOREA_UPSTREAM_BASE_URL = "http://apis.data.go.kr";
const SEOUL_OPEN_API_BASE_URL = "http://swopenapi.seoul.go.kr";
const OPINET_API_BASE_URL = "https://www.opinet.co.kr/api";
const NEIS_MEAL_SERVICE_URL = "https://open.neis.go.kr/hub/mealServiceDietInfo";
const NEIS_SCHOOL_INFO_URL = "https://open.neis.go.kr/hub/schoolInfo";
const ALLOWED_AIRKOREA_ROUTES = new Map([
  ["MsrstnInfoInqireSvc", new Set(["getMsrstnList", "getNearbyMsrstnList", "getTMStdrCrdnt"])],
  ["ArpltnInforInqireSvc", new Set(["getMsrstnAcctoRltmMesureDnsty", "getCtprvnRltmMesureDnsty"])],
  ["UserSportSvc", new Set(["getSvckeyDalyStats"])],
]);

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function trimOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "replace-me") {
    return null;
  }
  return trimmed;
}

function buildConfig(env = process.env) {
  return {
    host: env.KSKILL_PROXY_HOST || "127.0.0.1",
    port: parseInteger(env.KSKILL_PROXY_PORT, 4020),
    proxyName: env.KSKILL_PROXY_NAME || "k-skill-proxy",
    airKoreaApiKey: trimOrNull(env.AIR_KOREA_OPEN_API_KEY),
    seoulOpenApiKey: trimOrNull(env.SEOUL_OPEN_API_KEY),
    hrfcoApiKey: trimOrNull(env.HRFCO_OPEN_API_KEY),
    opinetApiKey: trimOrNull(env.OPINET_API_KEY),
    blueRibbonSessionId: trimOrNull(env.BLUE_RIBBON_SESSION_ID),
    molitApiKey: trimOrNull(env.DATA_GO_KR_API_KEY),
    keduInfoKey: trimOrNull(env.KEDU_INFO_KEY),
    cacheTtlMs: parseInteger(env.KSKILL_PROXY_CACHE_TTL_MS, 300000),
    rateLimitWindowMs: parseInteger(env.KSKILL_PROXY_RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: parseInteger(env.KSKILL_PROXY_RATE_LIMIT_MAX, 60)
  };
}

function makeCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function createMemoryCache() {
  const entries = new Map();

  return {
    get(key) {
      const cached = entries.get(key);
      if (!cached) {
        return null;
      }

      if (cached.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }

      return cached.value;
    },
    set(key, value, ttlMs) {
      entries.set(key, {
        value,
        expiresAt: Date.now() + ttlMs
      });
    }
  };
}

function buildRateLimiter(config) {
  const state = new Map();

  return function rateLimit(request, reply) {
    const key = trimOrNull(request.headers["cf-connecting-ip"]) || request.ip || "unknown";
    const now = Date.now();
    const current = state.get(key);

    if (!current || current.resetAt <= now) {
      state.set(key, {
        count: 1,
        resetAt: now + config.rateLimitWindowMs
      });
      return true;
    }

    if (current.count >= config.rateLimitMax) {
      reply.code(429).send({
        error: "rate_limited",
        message: "Too many requests.",
        retry_after_ms: current.resetAt - now
      });
      return false;
    }

    current.count += 1;
    return true;
  };
}

function normalizeFineDustQuery(query) {
  const regionHint = trimOrNull(query.regionHint ?? query.region_hint);
  const stationName = trimOrNull(query.stationName ?? query.station_name);

  if (!regionHint && !stationName) {
    throw new Error("Provide regionHint or stationName.");
  }

  return {
    regionHint,
    stationName
  };
}

function normalizeSeoulSubwayQuery(query) {
  const stationName = trimOrNull(query.stationName ?? query.station_name ?? query.station);
  if (!stationName) {
    throw new Error("Provide stationName.");
  }

  const startIndex = parseInteger(query.startIndex ?? query.start_index, 0);
  const endIndex = parseInteger(query.endIndex ?? query.end_index, 8);

  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error("Provide valid startIndex and endIndex.");
  }

  return {
    stationName,
    startIndex,
    endIndex
  };
}

function normalizeOpinetAroundQuery(query) {
  const x = parseFloatValue(query.x);
  const y = parseFloatValue(query.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Provide x and y as KATEC coordinates.");
  }
  const radius = parseInteger(query.radius, 1000);
  if (radius <= 0 || radius > 5000) {
    throw new Error("radius must be between 1 and 5000.");
  }
  const prodcd = trimOrNull(query.prodcd) || "B027";
  const sort = parseInteger(query.sort, 1);
  return { x, y, radius, prodcd, sort };
}

function normalizeOpinetDetailQuery(query) {
  const id = trimOrNull(query.id);
  if (!id) {
    throw new Error("Provide id.");
  }
  return { id };
}

function normalizeNeisSchoolMealQuery(query) {
  const atptOfcdcScCode = trimOrNull(
    query.atptOfcdcScCode ??
      query.ATPT_OFCDC_SC_CODE ??
      query.education_office_code ??
      query.educationOfficeCode
  );
  const sdSchulCode = trimOrNull(
    query.sdSchulCode ?? query.SD_SCHUL_CODE ?? query.school_code ?? query.schoolCode
  );
  const dateRaw = trimOrNull(
    query.mlsvYmd ?? query.MLSV_YMD ?? query.meal_date ?? query.mealDate ?? query.date
  );

  if (!atptOfcdcScCode) {
    throw new Error("Provide educationOfficeCode (ATPT_OFCDC_SC_CODE).");
  }
  if (!sdSchulCode) {
    throw new Error("Provide schoolCode (SD_SCHUL_CODE).");
  }
  if (!dateRaw) {
    throw new Error("Provide mealDate (MLSV_YMD) as YYYYMMDD.");
  }

  const mlsvYmd = dateRaw.replaceAll("-", "").replaceAll(".", "");
  if (!/^\d{8}$/.test(mlsvYmd)) {
    throw new Error("mealDate must be YYYYMMDD (8 digits).");
  }

  const mealKindRaw = trimOrNull(
    query.mmealScCode ?? query.MMEAL_SC_CODE ?? query.meal_kind_code ?? query.mealKindCode
  );
  let mmealScCode = null;
  if (mealKindRaw) {
    if (!["1", "2", "3"].includes(mealKindRaw)) {
      throw new Error("mealKindCode must be 1 (breakfast), 2 (lunch), or 3 (dinner).");
    }
    mmealScCode = mealKindRaw;
  }

  const pIndex = parseInteger(query.pIndex ?? query.p_index, 1);
  const pSize = parseInteger(query.pSize ?? query.p_size, 100);
  if (pIndex < 1) {
    throw new Error("pIndex must be >= 1.");
  }
  if (pSize < 1 || pSize > 1000) {
    throw new Error("pSize must be between 1 and 1000.");
  }

  return { atptOfcdcScCode, sdSchulCode, mlsvYmd, mmealScCode, pIndex, pSize };
}

function normalizeNeisSchoolSearchQuery(query) {
  const educationOfficeRaw = trimOrNull(
    query.educationOffice ??
      query.education_office ??
      query.office ??
      query.atpt ??
      query.ATPT_OFCDC_SC_CODE
  );
  const schoolNameRaw = trimOrNull(
    query.schoolName ?? query.school_name ?? query.school ?? query.SCHUL_NM ?? query.schulNm
  );

  if (!educationOfficeRaw) {
    throw new Error("Provide educationOffice (e.g. 서울특별시교육청 or B10).");
  }
  if (!schoolNameRaw) {
    throw new Error("Provide schoolName (e.g. 미래초등학교).");
  }

  const resolved = resolveEducationOfficeFromNaturalLanguage(educationOfficeRaw);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      const err = new Error(
        `educationOffice matched multiple offices (${resolved.codes.join(", ")}). Use a more specific name or pass the ATPT code (e.g. B10).`
      );
      err.code = "ambiguous_education_office";
      err.candidate_codes = resolved.codes;
      throw err;
    }
    throw new Error(
      "educationOffice is not a recognized regional office. Use names like 서울특별시교육청 or a code like B10."
    );
  }

  const pIndex = parseInteger(query.pIndex ?? query.p_index, 1);
  const pSize = parseInteger(query.pSize ?? query.p_size, 100);
  if (pIndex < 1) {
    throw new Error("pIndex must be >= 1.");
  }
  if (pSize < 1 || pSize > 1000) {
    throw new Error("pSize must be between 1 and 1000.");
  }

  return {
    educationOfficeInput: educationOfficeRaw,
    atptOfcdcScCode: resolved.code,
    resolvedOfficeLabel: resolved.matchedLabel,
    schulNm: schoolNameRaw,
    pIndex,
    pSize
  };
}

function normalizeBlueRibbonNearbyQuery(query) {
  const latitude = parseFloatValue(query.latitude ?? query.lat);
  const longitude = parseFloatValue(query.longitude ?? query.lng);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Provide latitude and longitude.");
  }

  const distanceMeters = parseInteger(query.distanceMeters ?? query.distance, 1000);
  if (distanceMeters <= 0 || distanceMeters > 5000) {
    throw new Error("distanceMeters must be between 1 and 5000.");
  }

  const limit = parseInteger(query.limit, 10);
  if (limit <= 0 || limit > 50) {
    throw new Error("limit must be between 1 and 50.");
  }

  return { latitude, longitude, distanceMeters, limit };
}

function normalizeRealEstateQuery(query) {
  const lawdCd = trimOrNull(query.lawd_cd ?? query.lawdCd);
  if (!lawdCd || !/^\d{5}$/.test(lawdCd)) {
    throw new Error("Provide lawd_cd as a 5-digit region code.");
  }

  const dealYmd = trimOrNull(query.deal_ymd ?? query.dealYmd);
  if (!dealYmd || !/^\d{6}$/.test(dealYmd)) {
    throw new Error("Provide deal_ymd as YYYYMM.");
  }

  const numOfRows = parseInteger(query.num_of_rows ?? query.numOfRows, 100);
  if (numOfRows < 1 || numOfRows > 1000) {
    throw new Error("num_of_rows must be between 1 and 1000.");
  }

  return { lawdCd, dealYmd, numOfRows };
}

function normalizeRegionCodeQuery(query) {
  const q = trimOrNull(query.q ?? query.query);
  if (!q) {
    throw new Error("Provide q (region name query).");
  }
  return { q };
}

function normalizeHouseholdWasteInfoQuery(query) {
  const sggNm = trimOrNull(query["cond[SGG_NM::LIKE]"]);
  if (!sggNm) {
    throw new Error("cond[SGG_NM::LIKE] is required");
  }

  const pageNoRaw = trimOrNull(query.pageNo ?? query.page_no) || "1";
  if (!/^\d+$/.test(pageNoRaw)) {
    throw new Error("pageNo must be an integer >= 1.");
  }
  const pageNo = Number.parseInt(pageNoRaw, 10);
  if (pageNo < 1) {
    throw new Error("pageNo must be an integer >= 1.");
  }

  const numOfRowsRaw = trimOrNull(query.numOfRows ?? query.num_of_rows) || "20";
  if (!/^\d+$/.test(numOfRowsRaw)) {
    throw new Error("numOfRows must be an integer between 1 and 100.");
  }
  const numOfRows = Number.parseInt(numOfRowsRaw, 10);
  if (numOfRows < 1 || numOfRows > 100) {
    throw new Error("numOfRows must be an integer between 1 and 100.");
  }

  return {
    sggNm,
    pageNo: String(pageNo),
    numOfRows: String(numOfRows)
  };
}

function normalizeHanRiverWaterLevelQuery(query) {
  const stationName = trimOrNull(query.stationName ?? query.station_name ?? query.station);
  const stationCode = trimOrNull(query.stationCode ?? query.station_code ?? query.wlobscd);

  if (!stationName && !stationCode) {
    throw new Error("Provide stationName or stationCode.");
  }

  return {
    stationName,
    stationCode
  };
}


function isAllowedAirKoreaRoute(service, operation) {
  return ALLOWED_AIRKOREA_ROUTES.get(service)?.has(operation) || false;
}

async function proxyAirKoreaRequest({ service, operation, query, serviceKey, fetchImpl = global.fetch }) {
  if (!serviceKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "AIR_KOREA_OPEN_API_KEY is not configured on the proxy server."
      })
    };
  }

  if (!isAllowedAirKoreaRoute(service, operation)) {
    return {
      statusCode: 404,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "not_found",
        message: "That AirKorea route is not exposed by this proxy."
      })
    };
  }

  const url = new URL(`${AIR_KOREA_UPSTREAM_BASE_URL}/B552584/${service}/${operation}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "" || key === "serviceKey") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("serviceKey", serviceKey);

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20000)
  });
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
    body: await response.text()
  };
}

async function proxySeoulSubwayRequest({
  stationName,
  startIndex = 0,
  endIndex = 8,
  apiKey,
  fetchImpl = global.fetch
}) {
  if (!apiKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "SEOUL_OPEN_API_KEY is not configured on the proxy server."
      })
    };
  }

  const encodedStationName = encodeURIComponent(stationName);
  const url = new URL(
    `${SEOUL_OPEN_API_BASE_URL}/api/subway/${apiKey}/json/realtimeStationArrival/${startIndex}/${endIndex}/${encodedStationName}`
  );

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20000)
  });

  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
    body: await response.text()
  };
}

async function proxyOpinetRequest({ path, params, apiKey, fetchImpl = global.fetch }) {
  if (!apiKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "OPINET_API_KEY is not configured on the proxy server."
      })
    };
  }

  const url = new URL(`${OPINET_API_BASE_URL}/${path}`);
  url.searchParams.set("out", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("certkey", apiKey);

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20000)
  });

  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
    body: await response.text()
  };
}

async function proxyHrfcoWaterLevelRequest({
  stationName = null,
  stationCode = null,
  apiKey,
  fetchImpl = global.fetch
}) {
  if (!apiKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "HRFCO_OPEN_API_KEY is not configured on the proxy server."
      })
    };
  }

  try {
    const report = await fetchWaterLevelReport({
      stationName,
      stationCode,
      serviceKey: apiKey,
      fetchImpl
    });

    return {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(report)
    };
  } catch (error) {
    const payload = {
      error: error.code || "proxy_error",
      message: error.message
    };

    if (Array.isArray(error.candidateStations)) {
      payload.candidate_stations = error.candidateStations;
    }

    return {
      statusCode: error.statusCode && error.statusCode >= 400 ? error.statusCode : 502,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(payload)
    };
  }
}

async function proxyNeisSchoolMealRequest({
  apiKey,
  atptOfcdcScCode,
  sdSchulCode,
  mlsvYmd,
  mmealScCode = null,
  pIndex = 1,
  pSize = 100,
  fetchImpl = global.fetch
}) {
  if (!apiKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "KEDU_INFO_KEY is not configured on the proxy server."
      })
    };
  }

  const url = new URL(NEIS_MEAL_SERVICE_URL);
  url.searchParams.set("KEY", apiKey);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", String(pIndex));
  url.searchParams.set("pSize", String(pSize));
  url.searchParams.set("ATPT_OFCDC_SC_CODE", atptOfcdcScCode);
  url.searchParams.set("SD_SCHUL_CODE", sdSchulCode);
  url.searchParams.set("MLSV_YMD", mlsvYmd);
  if (mmealScCode) {
    url.searchParams.set("MMEAL_SC_CODE", mmealScCode);
  }

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20000)
  });

  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
    body: await response.text()
  };
}

async function proxyNeisSchoolInfoRequest({
  apiKey,
  atptOfcdcScCode,
  schulNm,
  pIndex = 1,
  pSize = 100,
  fetchImpl = global.fetch
}) {
  if (!apiKey) {
    return {
      statusCode: 503,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        error: "upstream_not_configured",
        message: "KEDU_INFO_KEY is not configured on the proxy server."
      })
    };
  }

  const url = new URL(NEIS_SCHOOL_INFO_URL);
  url.searchParams.set("KEY", apiKey);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", String(pIndex));
  url.searchParams.set("pSize", String(pSize));
  url.searchParams.set("ATPT_OFCDC_SC_CODE", atptOfcdcScCode);
  url.searchParams.set("SCHUL_NM", schulNm);

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(20000)
  });

  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
    body: await response.text()
  };
}


function buildServer({ env = process.env, provider = null } = {}) {
  const config = buildConfig(env);
  const cache = createMemoryCache();
  const rateLimit = buildRateLimiter(config);
  const app = Fastify({
    logger: true,
    disableRequestLogging: true
  });

  app.decorate("configValues", config);
  app.decorate("provider", provider || ((params) => fetchFineDustReport({
    ...params,
    serviceKey: config.airKoreaApiKey
  })));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }

    if (!rateLimit(request, reply)) {
      return reply;
    }
  });

  app.get("/health", async () => ({
    ok: true,
    service: config.proxyName,
    port: config.port,
    upstreams: {
      airKoreaConfigured: Boolean(config.airKoreaApiKey),
      blueRibbonConfigured: Boolean(config.blueRibbonSessionId),
      seoulOpenApiConfigured: Boolean(config.seoulOpenApiKey),
      hrfcoConfigured: Boolean(config.hrfcoApiKey),
      opinetConfigured: Boolean(config.opinetApiKey),
      molitConfigured: Boolean(config.molitApiKey),
      neisSchoolMealConfigured: Boolean(config.keduInfoKey)
    },
    auth: {
      tokenRequired: false
    },
    timestamp: new Date().toISOString()
  }));

  app.get("/B552584/:service/:operation", async (request, reply) => {
    const { service, operation } = request.params;
    const upstream = await proxyAirKoreaRequest({
      service,
      operation,
      query: request.query,
      serviceKey: config.airKoreaApiKey
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);
    return upstream.body;
  });

  app.get("/v1/fine-dust/report", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeFineDustQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey(normalized);
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    if (!config.airKoreaApiKey) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "AIR_KOREA_OPEN_API_KEY is not configured on the proxy server.",
        proxy: {
          name: config.proxyName,
          cache: {
            hit: false,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const report = await app.provider(normalized);
    const payload = {
      ...report,
      proxy: {
        name: config.proxyName,
        cache: {
          hit: false,
          ttl_ms: config.cacheTtlMs
        },
        requested_at: new Date().toISOString()
      }
    };

    cache.set(cacheKey, payload, config.cacheTtlMs);
    return payload;
  });

  app.get("/v1/seoul-subway/arrival", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeSeoulSubwayQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "seoul-subway-arrival",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxySeoulSubwayRequest({
      ...normalized,
      apiKey: config.seoulOpenApiKey
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    if (!upstream.contentType.includes("json")) {
      return upstream.body;
    }

    const payload = JSON.parse(upstream.body);
    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });

  app.get("/v1/han-river/water-level", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeHanRiverWaterLevelQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "han-river-water-level",
      stationName: normalized.stationName?.toLowerCase() || null,
      stationCode: normalized.stationCode || null
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxyHrfcoWaterLevelRequest({
      ...normalized,
      apiKey: config.hrfcoApiKey
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    if (!upstream.contentType.includes("json")) {
      return upstream.body;
    }

    const payload = JSON.parse(upstream.body);
    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });

  app.get("/v1/blue-ribbon/nearby", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeBlueRibbonNearbyQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    if (!config.blueRibbonSessionId) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "BLUE_RIBBON_SESSION_ID is not configured on the proxy server."
      };
    }

    const cacheKey = makeCacheKey({
      route: "blue-ribbon-nearby",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const result = await proxyBlueRibbonNearbyRequest({
      ...normalized,
      sessionId: config.blueRibbonSessionId
    });

    const payload = {
      ...result,
      query: normalized,
      proxy: {
        name: config.proxyName,
        cache: {
          hit: false,
          ttl_ms: config.cacheTtlMs
        },
        requested_at: new Date().toISOString()
      }
    };

    cache.set(cacheKey, payload, config.cacheTtlMs);
    return payload;
  });

  app.get("/v1/opinet/around", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeOpinetAroundQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "opinet-around",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxyOpinetRequest({
      path: "aroundAll.do",
      params: normalized,
      apiKey: config.opinetApiKey
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    if (!upstream.contentType.includes("json")) {
      return upstream.body;
    }

    const payload = JSON.parse(upstream.body);
    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });

  app.get("/v1/opinet/detail", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeOpinetDetailQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "opinet-detail",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxyOpinetRequest({
      path: "detailById.do",
      params: normalized,
      apiKey: config.opinetApiKey
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    if (!upstream.contentType.includes("json")) {
      return upstream.body;
    }

    const payload = JSON.parse(upstream.body);
    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });


  app.get("/v1/real-estate/region-code", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeRegionCodeQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "real-estate-region-code",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const results = searchRegionCode(normalized.q);
    const payload = {
      results,
      query: normalized.q,
      proxy: {
        name: config.proxyName,
        cache: {
          hit: false,
          ttl_ms: config.cacheTtlMs
        },
        requested_at: new Date().toISOString()
      }
    };

    cache.set(cacheKey, payload, config.cacheTtlMs);
    return payload;
  });

  app.get("/v1/real-estate/:assetType/:dealType", async (request, reply) => {
    const { assetType, dealType } = request.params;

    if (!VALID_ASSET_TYPES.has(assetType)) {
      reply.code(404);
      return {
        error: "not_found",
        message: `Unknown asset type: ${assetType}. Valid: apartment, officetel, villa, single-house, commercial`
      };
    }

    if (!VALID_DEAL_TYPES.has(dealType)) {
      reply.code(404);
      return {
        error: "not_found",
        message: `Unknown deal type: ${dealType}. Valid: trade, rent`
      };
    }

    if (assetType === "commercial" && dealType === "rent") {
      reply.code(404);
      return {
        error: "not_found",
        message: "commercial/rent is not available. Only commercial/trade is supported."
      };
    }

    let normalized;

    try {
      normalized = normalizeRealEstateQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "real-estate",
      assetType,
      dealType,
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    if (!config.molitApiKey) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "DATA_GO_KR_API_KEY is not configured on the proxy server.",
        proxy: {
          name: config.proxyName,
          cache: {
            hit: false,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const result = await fetchTransactions({
      assetType,
      dealType,
      lawdCd: normalized.lawdCd,
      dealYmd: normalized.dealYmd,
      numOfRows: normalized.numOfRows,
      serviceKey: config.molitApiKey
    });

    if (result.error) {
      reply.code(502);
      return {
        ...result,
        proxy: {
          name: config.proxyName,
          cache: {
            hit: false,
            ttl_ms: config.cacheTtlMs
          },
          requested_at: new Date().toISOString()
        }
      };
    }

    const payload = {
      ...result,
      query: {
        asset_type: assetType,
        deal_type: dealType,
        lawd_cd: normalized.lawdCd,
        deal_ymd: normalized.dealYmd
      },
      proxy: {
        name: config.proxyName,
        cache: {
          hit: false,
          ttl_ms: config.cacheTtlMs
        },
        requested_at: new Date().toISOString()
      }
    };

    cache.set(cacheKey, payload, config.cacheTtlMs);
    return payload;
  });

  app.get("/v1/household-waste/info", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeHouseholdWasteInfoQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "household-waste-info",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: { hit: true, ttl_ms: config.cacheTtlMs }
        }
      };
    }

    if (!config.molitApiKey) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "DATA_GO_KR_API_KEY is not configured on the proxy server.",
        proxy: { name: config.proxyName, cache: { hit: false, ttl_ms: config.cacheTtlMs } }
      };
    }

    const url = new URL("https://apis.data.go.kr/1741000/household_waste_info/info");
    url.searchParams.set("serviceKey", config.molitApiKey);
    url.searchParams.set("pageNo", normalized.pageNo);
    url.searchParams.set("numOfRows", normalized.numOfRows);
    url.searchParams.set("returnType", "json");
    url.searchParams.set("cond[SGG_NM::LIKE]", normalized.sggNm);

    let upstreamData;
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        reply.code(502);
        return {
          error: "upstream_error",
          message: `Upstream responded with ${res.status}`,
          proxy: { name: config.proxyName, cache: { hit: false, ttl_ms: config.cacheTtlMs } }
        };
      }
      upstreamData = await res.json();
    } catch (err) {
      reply.code(502);
      return {
        error: "upstream_fetch_failed",
        message: err.message,
        proxy: { name: config.proxyName, cache: { hit: false, ttl_ms: config.cacheTtlMs } }
      };
    }

    const payload = {
      ...upstreamData,
      query: {
        sgg_nm: normalized.sggNm,
        page_no: normalized.pageNo,
        num_of_rows: normalized.numOfRows
      },
      proxy: {
        name: config.proxyName,
        cache: { hit: false, ttl_ms: config.cacheTtlMs },
        requested_at: new Date().toISOString()
      }
    };

    cache.set(cacheKey, payload, config.cacheTtlMs);
    return payload;
  });

  app.get("/v1/neis/school-search", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeNeisSchoolSearchQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      const payload = {
        error: error.code === "ambiguous_education_office" ? error.code : "bad_request",
        message: error.message
      };
      if (Array.isArray(error.candidate_codes)) {
        payload.candidate_codes = error.candidate_codes;
      }
      return payload;
    }

    const cacheKey = makeCacheKey({
      route: "neis-school-search",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    if (!config.keduInfoKey) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "KEDU_INFO_KEY is not configured on the proxy server.",
        proxy: {
          name: config.proxyName,
          cache: {
            hit: false,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxyNeisSchoolInfoRequest({
      apiKey: config.keduInfoKey,
      atptOfcdcScCode: normalized.atptOfcdcScCode,
      schulNm: normalized.schulNm,
      pIndex: normalized.pIndex,
      pSize: normalized.pSize
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    const looksJson =
      upstream.contentType.includes("json") ||
      upstream.body.trimStart().startsWith("{") ||
      upstream.body.trimStart().startsWith("[");

    if (!looksJson) {
      return upstream.body;
    }

    let payload;
    try {
      payload = JSON.parse(upstream.body);
    } catch {
      return upstream.body;
    }

    payload.resolved_education_office = {
      input: normalized.educationOfficeInput,
      atpt_ofcdc_sc_code: normalized.atptOfcdcScCode,
      matched_label: normalized.resolvedOfficeLabel
    };
    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };
    payload.query = {
      education_office: normalized.educationOfficeInput,
      school_name: normalized.schulNm,
      p_index: normalized.pIndex,
      p_size: normalized.pSize
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });

  app.get("/v1/neis/school-meal", async (request, reply) => {
    let normalized;

    try {
      normalized = normalizeNeisSchoolMealQuery(request.query || {});
    } catch (error) {
      reply.code(400);
      return {
        error: "bad_request",
        message: error.message
      };
    }

    const cacheKey = makeCacheKey({
      route: "neis-school-meal",
      ...normalized
    });
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        proxy: {
          ...cached.proxy,
          cache: {
            hit: true,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    if (!config.keduInfoKey) {
      reply.code(503);
      return {
        error: "upstream_not_configured",
        message: "KEDU_INFO_KEY is not configured on the proxy server.",
        proxy: {
          name: config.proxyName,
          cache: {
            hit: false,
            ttl_ms: config.cacheTtlMs
          }
        }
      };
    }

    const upstream = await proxyNeisSchoolMealRequest({
      apiKey: config.keduInfoKey,
      atptOfcdcScCode: normalized.atptOfcdcScCode,
      sdSchulCode: normalized.sdSchulCode,
      mlsvYmd: normalized.mlsvYmd,
      mmealScCode: normalized.mmealScCode,
      pIndex: normalized.pIndex,
      pSize: normalized.pSize
    });

    reply.code(upstream.statusCode);
    reply.header("content-type", upstream.contentType);

    const looksJson =
      upstream.contentType.includes("json") ||
      upstream.body.trimStart().startsWith("{") ||
      upstream.body.trimStart().startsWith("[");

    if (!looksJson) {
      return upstream.body;
    }

    let payload;
    try {
      payload = JSON.parse(upstream.body);
    } catch {
      return upstream.body;
    }

    payload.proxy = {
      name: config.proxyName,
      cache: {
        hit: false,
        ttl_ms: config.cacheTtlMs
      },
      requested_at: new Date().toISOString()
    };
    payload.query = {
      education_office_code: normalized.atptOfcdcScCode,
      school_code: normalized.sdSchulCode,
      meal_date: normalized.mlsvYmd,
      meal_kind_code: normalized.mmealScCode,
      p_index: normalized.pIndex,
      p_size: normalized.pSize
    };

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      cache.set(cacheKey, payload, config.cacheTtlMs);
    }

    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const payload = {
      error: error.code || (statusCode >= 500 ? "proxy_error" : "request_error"),
      message: error.message
    };

    if (Array.isArray(error.candidateStations)) {
      payload.candidate_stations = error.candidateStations;
    }

    if (Array.isArray(error.candidate_codes)) {
      payload.candidate_codes = error.candidate_codes;
    }

    if (error.sidoName) {
      payload.sido_name = error.sidoName;
    }

    reply.code(statusCode).send(payload);
  });

  return app;
}

async function startServer() {
  const app = buildServer();
  const { host, port } = app.configValues;
  await app.listen({ host, port });
  return app;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildConfig,
  buildServer,
  normalizeBlueRibbonNearbyQuery,
  normalizeFineDustQuery,
  normalizeHanRiverWaterLevelQuery,
  normalizeOpinetAroundQuery,
  normalizeOpinetDetailQuery,
  normalizeNeisSchoolMealQuery,
  normalizeNeisSchoolSearchQuery,
  normalizeHouseholdWasteInfoQuery,
  normalizeRealEstateQuery,
  normalizeRegionCodeQuery,
  normalizeSeoulSubwayQuery,
  proxyAirKoreaRequest,
  proxyHrfcoWaterLevelRequest,
  proxyNeisSchoolMealRequest,
  proxyNeisSchoolInfoRequest,
  proxyOpinetRequest,
  proxySeoulSubwayRequest,
  startServer
};
