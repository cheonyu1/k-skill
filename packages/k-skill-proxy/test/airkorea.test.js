const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReport,
  fetchFineDustReport,
  pickStation,
  wgs84ToAirKoreaTm
} = require("../src/airkorea");

const stationPayload = {
  response: {
    body: {
      items: [
        {
          stationName: "강남구",
          addr: "서울 강남구 학동로 426",
          dmX: 37.5179,
          dmY: 127.0473
        },
        {
          stationName: "중구",
          addr: "서울 중구 서소문로 124",
          dmX: 37.564,
          dmY: 126.975
        }
      ]
    }
  }
};

const measurementPayload = {
  response: {
    body: {
      items: [
        {
          stationName: "강남구",
          dataTime: "2026-03-27 21:00",
          pm10Value: "42",
          pm10Grade: "2",
          pm25Value: "19",
          pm25Grade: "2",
          khaiGrade: "2"
        }
      ]
    }
  }
};

test("wgs84 coordinates are converted to AirKorea TM", () => {
  const { tmX, tmY } = wgs84ToAirKoreaTm(37.5665, 126.9780);

  assert.ok(Math.abs(tmX - 198245.053) < 0.01);
  assert.ok(Math.abs(tmY - 451586.838) < 0.01);
});

test("pickStation prefers specific region token matches", () => {
  const station = pickStation(stationPayload.response.body.items, {
    regionHint: "서울 강남구"
  });

  assert.equal(station.stationName, "강남구");
});

test("buildReport combines station and measurement summary", () => {
  const report = buildReport({
    stationItems: stationPayload.response.body.items,
    measurementItems: measurementPayload.response.body.items,
    regionHint: "서울 강남구"
  });

  assert.equal(report.station_name, "강남구");
  assert.deepEqual(report.pm10, { value: "42", grade: "보통" });
  assert.deepEqual(report.pm25, { value: "19", grade: "보통" });
  assert.equal(report.lookup_mode, "fallback");
});

test("fetchFineDustReport falls back to region lookup when nearby returns empty", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));

    if (String(url).includes("getNearbyMsrstnList")) {
      return new Response(JSON.stringify({ response: { body: { items: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (String(url).includes("getMsrstnList")) {
      return new Response(JSON.stringify({
        response: {
          body: {
            items: [stationPayload.response.body.items[0]]
          }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (String(url).includes("getMsrstnAcctoRltmMesureDnsty")) {
      return new Response(JSON.stringify(measurementPayload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`unexpected URL: ${url}`);
  };

  const report = await fetchFineDustReport({
    lat: 37.5665,
    lon: 126.978,
    regionHint: "서울 강남구",
    serviceKey: "test-key",
    fetchImpl
  });

  assert.equal(report.station_name, "강남구");
  assert.equal(report.lookup_mode, "fallback");
  assert.deepEqual(calls.map((url) => url.split("/").at(-1)?.split("?")[0]), [
    "getNearbyMsrstnList",
    "getMsrstnList",
    "getMsrstnAcctoRltmMesureDnsty"
  ]);
});

test("fetchFineDustReport falls back to direct measurement lookup when station-info access is forbidden", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const text = String(url);
    calls.push(text);

    if (text.includes("getMsrstnList")) {
      return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
    }

    if (text.includes("getMsrstnAcctoRltmMesureDnsty")) {
      return new Response(JSON.stringify(measurementPayload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    throw new Error(`unexpected URL: ${url}`);
  };

  const report = await fetchFineDustReport({
    regionHint: "서울 강남구",
    serviceKey: "test-key",
    fetchImpl
  });

  assert.equal(report.station_name, "강남구");
  assert.equal(report.station_address, null);
  assert.equal(report.lookup_mode, "fallback");
  assert.deepEqual(calls.map((url) => url.split("/").at(-1)?.split("?")[0]), [
    "getMsrstnList",
    "getMsrstnAcctoRltmMesureDnsty"
  ]);
});
