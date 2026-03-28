const test = require("node:test");
const assert = require("node:assert/strict");

const { buildServer, proxyAirKoreaRequest } = require("../src/server");

test("health endpoint stays public and reports auth/upstream status", async (t) => {
  const app = buildServer({
    provider: async () => {
      throw new Error("provider should not be called");
    }
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.auth.tokenRequired, false);
  assert.equal(body.upstreams.airKoreaConfigured, false);
});

test("fine dust endpoint stays publicly callable without proxy auth", async (t) => {
  let providerCalls = 0;
  const app = buildServer({
    env: {
      AIR_KOREA_OPEN_API_KEY: "airkorea-key"
    },
    provider: async () => {
      providerCalls += 1;
      return { station_name: "강남구" };
    }
  });

  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/fine-dust/report?regionHint=%EC%84%9C%EC%9A%B8%20%EA%B0%95%EB%82%A8%EA%B5%AC"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().station_name, "강남구");
  assert.equal(providerCalls, 1);
});

test("fine dust endpoint caches successful provider responses", async (t) => {
  let providerCalls = 0;
  const app = buildServer({
    env: {
      AIR_KOREA_OPEN_API_KEY: "airkorea-key",
      KSKILL_PROXY_CACHE_TTL_MS: "60000"
    },
    provider: async () => {
      providerCalls += 1;
      return {
        station_name: "강남구",
        station_address: "서울 강남구 학동로 426",
        lookup_mode: "fallback",
        measured_at: "2026-03-27 21:00",
        pm10: { value: "42", grade: "보통" },
        pm25: { value: "19", grade: "보통" },
        khai_grade: "보통"
      };
    }
  });

  t.after(async () => {
    await app.close();
  });

  const request = {
    method: "GET",
    url: "/v1/fine-dust/report?regionHint=%EC%84%9C%EC%9A%B8%20%EA%B0%95%EB%82%A8%EA%B5%AC"
  };

  const first = await app.inject(request);
  const second = await app.inject(request);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(providerCalls, 1);
  assert.equal(first.json().proxy.cache.hit, false);
  assert.equal(second.json().proxy.cache.hit, true);
});

test("proxyAirKoreaRequest injects serviceKey and preserves caller query params", async () => {
  let calledUrl;
  const result = await proxyAirKoreaRequest({
    service: "ArpltnInforInqireSvc",
    operation: "getMsrstnAcctoRltmMesureDnsty",
    query: {
      returnType: "json",
      stationName: "강남구",
      dataTerm: "DAILY",
      ver: "1.4"
    },
    serviceKey: "test-service-key",
    fetchImpl: async (url) => {
      calledUrl = String(url);
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json;charset=UTF-8" }
      });
    }
  });

  assert.equal(result.statusCode, 200);
  assert.match(calledUrl, /\/B552584\/ArpltnInforInqireSvc\/getMsrstnAcctoRltmMesureDnsty\?/);
  assert.match(calledUrl, /stationName=%EA%B0%95%EB%82%A8%EA%B5%AC/);
  assert.match(calledUrl, /serviceKey=test-service-key/);
});

test("public AirKorea passthrough route forwards allowed upstream responses", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response('{"response":{"header":{"resultCode":"00"}}}', {
      status: 200,
      headers: { "content-type": "application/json;charset=UTF-8" }
    });

  const app = buildServer({
    env: {
      AIR_KOREA_OPEN_API_KEY: "airkorea-key"
    }
  });

  t.after(async () => {
    global.fetch = originalFetch;
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty?returnType=json&stationName=%EA%B0%95%EB%82%A8%EA%B5%AC&dataTerm=DAILY&ver=1.4"
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /resultCode/);
});
