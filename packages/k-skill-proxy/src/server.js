const crypto = require("node:crypto");
const Fastify = require("fastify");
const { fetchFineDustReport } = require("./airkorea");
const UPSTREAM_BASE_URL = "http://apis.data.go.kr";
const ALLOWED_AIRKOREA_ROUTES = new Map([
  ["MsrstnInfoInqireSvc", new Set(["getMsrstnList", "getNearbyMsrstnList", "getTMStdrCrdnt"])],
  ["ArpltnInforInqireSvc", new Set(["getMsrstnAcctoRltmMesureDnsty"])],
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
  const lat = parseFloatValue(query.lat);
  const lon = parseFloatValue(query.lon);
  const regionHint = trimOrNull(query.regionHint ?? query.region_hint);
  const stationName = trimOrNull(query.stationName ?? query.station_name);

  if ((lat !== null && Number.isNaN(lat)) || (lon !== null && Number.isNaN(lon))) {
    throw new Error("lat/lon must be finite numbers.");
  }

  if ((lat === null) !== (lon === null)) {
    throw new Error("lat and lon must be provided together.");
  }

  if (lat === null && !regionHint && !stationName) {
    throw new Error("Provide lat/lon, regionHint, or stationName.");
  }

  return {
    lat,
    lon,
    regionHint,
    stationName
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

  const url = new URL(`${UPSTREAM_BASE_URL}/B552584/${service}/${operation}`);
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
      airKoreaConfigured: Boolean(config.airKoreaApiKey)
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

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "proxy_error" : "request_error",
      message: error.message
    });
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
  normalizeFineDustQuery,
  proxyAirKoreaRequest,
  startServer
};
