const STATION_SERVICE_URL = "http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc";
const MEASUREMENT_SERVICE_URL = "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc";
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const BESSEL_A = 6377397.155;
const BESSEL_F = 1 / 299.1528128;
const AIR_KOREA_TM_LAT0 = degreesToRadians(38.0);
const AIR_KOREA_TM_LON0 = degreesToRadians(127.0);
const AIR_KOREA_TM_FALSE_EASTING = 200000.0;
const AIR_KOREA_TM_FALSE_NORTHING = 500000.0;
const AIR_KOREA_TM_SCALE = 1.0;
const AIR_KOREA_WGS84_TO_BESSEL = [146.43, -507.89, -681.46];
const GRADE_LABELS = {
  "1": "좋음",
  "2": "보통",
  "3": "나쁨",
  "4": "매우나쁨"
};

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function extractItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const items = payload?.response?.body?.items;

  if (Array.isArray(items)) {
    return items;
  }

  if (items && typeof items === "object") {
    return [items];
  }

  return [];
}

function toFloat(raw) {
  if (raw === null || raw === undefined || raw === "" || raw === "-") {
    return null;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function squaredDistance(latA, lonA, latB, lonB) {
  return (latA - latB) ** 2 + (lonA - lonB) ** 2;
}

function meridionalArc(phi, { semiMajorAxis, eccentricitySquared }) {
  const e2 = eccentricitySquared;

  return semiMajorAxis * (
    (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
    ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
    ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
    ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi)
  );
}

function wgs84ToBessel(latitude, longitude) {
  const [dx, dy, dz] = AIR_KOREA_WGS84_TO_BESSEL;
  const sourceE2 = 2 * WGS84_F - WGS84_F ** 2;
  const targetE2 = 2 * BESSEL_F - BESSEL_F ** 2;

  const latRad = degreesToRadians(latitude);
  const lonRad = degreesToRadians(longitude);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const primeVerticalRadius = WGS84_A / Math.sqrt(1 - sourceE2 * sinLat * sinLat);

  const x = primeVerticalRadius * cosLat * Math.cos(lonRad) + dx;
  const y = primeVerticalRadius * cosLat * Math.sin(lonRad) + dy;
  const z = primeVerticalRadius * (1 - sourceE2) * sinLat + dz;

  const lonBessel = Math.atan2(y, x);
  const horizontal = Math.sqrt(x * x + y * y);
  let latBessel = Math.atan2(z, horizontal * (1 - targetE2));

  for (let index = 0; index < 8; index += 1) {
    const sinLatBessel = Math.sin(latBessel);
    const besselRadius = BESSEL_A / Math.sqrt(1 - targetE2 * sinLatBessel * sinLatBessel);
    const nextLat = Math.atan2(z + targetE2 * besselRadius * sinLatBessel, horizontal);

    if (Math.abs(nextLat - latBessel) < 1e-14) {
      latBessel = nextLat;
      break;
    }

    latBessel = nextLat;
  }

  return [latBessel, lonBessel];
}

function wgs84ToAirKoreaTm(latitude, longitude) {
  const [latRad, lonRad] = wgs84ToBessel(latitude, longitude);
  const besselE2 = 2 * BESSEL_F - BESSEL_F ** 2;
  const secondEccentricitySquared = besselE2 / (1 - besselE2);

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);

  const primeVerticalRadius = BESSEL_A / Math.sqrt(1 - besselE2 * sinLat * sinLat);
  const tanSquared = tanLat * tanLat;
  const curvature = secondEccentricitySquared * cosLat * cosLat;
  const A = (lonRad - AIR_KOREA_TM_LON0) * cosLat;

  const meridional = meridionalArc(latRad, {
    semiMajorAxis: BESSEL_A,
    eccentricitySquared: besselE2
  });
  const meridionalOrigin = meridionalArc(AIR_KOREA_TM_LAT0, {
    semiMajorAxis: BESSEL_A,
    eccentricitySquared: besselE2
  });

  const tmX = AIR_KOREA_TM_FALSE_EASTING + AIR_KOREA_TM_SCALE * primeVerticalRadius * (
    A +
    ((1 - tanSquared + curvature) * A ** 3) / 6 +
    ((5 - 18 * tanSquared + tanSquared ** 2 + 72 * curvature - 58 * secondEccentricitySquared) * A ** 5) / 120
  );
  const tmY = AIR_KOREA_TM_FALSE_NORTHING + AIR_KOREA_TM_SCALE * (
    meridional -
    meridionalOrigin +
    primeVerticalRadius * tanLat * (
      A ** 2 / 2 +
      ((5 - tanSquared + 9 * curvature + 4 * curvature ** 2) * A ** 4) / 24 +
      ((61 - 58 * tanSquared + tanSquared ** 2 + 600 * curvature - 330 * secondEccentricitySquared) * A ** 6) / 720
    )
  );

  return { tmX, tmY };
}

function pickStation(stationItems, { lat = null, lon = null, regionHint = null, stationName = null } = {}) {
  if (!stationItems.length) {
    throw new Error("측정소 후보가 없습니다.");
  }

  if (stationName) {
    const exactMatch = stationItems.find((item) => item.stationName === stationName);
    if (exactMatch) {
      return exactMatch;
    }

    const partialMatch = stationItems.find((item) =>
      String(item.stationName || "").includes(stationName) || String(item.addr || "").includes(stationName)
    );
    if (partialMatch) {
      return partialMatch;
    }
  }

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const candidates = stationItems
      .map((item) => {
        const itemLat = toFloat(item.dmX);
        const itemLon = toFloat(item.dmY);

        if (itemLat === null || itemLon === null) {
          return null;
        }

        return [squaredDistance(lat, lon, itemLat, itemLon), item];
      })
      .filter(Boolean)
      .sort((left, right) => left[0] - right[0]);

    if (candidates.length > 0) {
      return candidates[0][1];
    }
  }

  if (regionHint) {
    const tokens = [...new Set(String(regionHint).split(/\s+/u).filter(Boolean))].sort((left, right) => right.length - left.length);

    for (const token of tokens) {
      const stationNameMatch = stationItems.find((item) => String(item.stationName || "").includes(token));
      if (stationNameMatch) {
        return stationNameMatch;
      }

      const addressMatch = stationItems.find((item) => String(item.addr || "").includes(token));
      if (addressMatch) {
        return addressMatch;
      }
    }
  }

  return stationItems[0];
}

function resolveStation(stationItems, options = {}) {
  if (stationItems.length > 0) {
    return pickStation(stationItems, options);
  }

  if (options.stationName) {
    return {
      stationName: options.stationName,
      addr: null
    };
  }

  throw new Error("측정소 후보가 없습니다.");
}

function buildStationNameCandidates({ stationName = null, regionHint = null } = {}) {
  const candidates = [];

  if (stationName) {
    candidates.push(String(stationName).trim());
  }

  if (regionHint) {
    const tokens = [...new Set(
      String(regionHint)
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter(Boolean)
        .sort((left, right) => right.length - left.length)
    )];
    candidates.push(...tokens);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function findMeasurement(measurementItems, stationName) {
  const exactMatch = measurementItems.find((item) => item.stationName === stationName);
  if (exactMatch) {
    return exactMatch;
  }

  const partialMatch = measurementItems.find((item) => String(item.stationName || "").includes(stationName));
  if (partialMatch) {
    return partialMatch;
  }

  throw new Error(`측정값 응답에서 측정소 '${stationName}' 를 찾지 못했습니다.`);
}

function gradeToLabel(rawGrade, { pollutant, value }) {
  const rawText = rawGrade === null || rawGrade === undefined ? "" : String(rawGrade);
  if (Object.prototype.hasOwnProperty.call(GRADE_LABELS, rawText)) {
    return GRADE_LABELS[rawText];
  }

  const numericValue = toFloat(value);
  if (numericValue === null) {
    return "정보없음";
  }

  const thresholds = pollutant === "pm10"
    ? [[30, "좋음"], [80, "보통"], [150, "나쁨"]]
    : [[15, "좋음"], [35, "보통"], [75, "나쁨"]];

  for (const [threshold, label] of thresholds) {
    if (numericValue <= threshold) {
      return label;
    }
  }

  return "매우나쁨";
}

function buildReport({ stationItems, measurementItems, lat = null, lon = null, regionHint = null, stationName = null, lookupMode = null, selectedStation = null }) {
  const station = selectedStation || resolveStation(stationItems, {
    lat,
    lon,
    regionHint,
    stationName
  });
  const measurement = findMeasurement(measurementItems, station.stationName);
  const resolvedLookupMode = lookupMode || (Number.isFinite(lat) && Number.isFinite(lon) ? "coordinates" : "fallback");

  return {
    station_name: station.stationName,
    station_address: station.addr ?? null,
    lookup_mode: resolvedLookupMode,
    measured_at: measurement.dataTime ?? null,
    pm10: {
      value: String(measurement.pm10Value ?? "-"),
      grade: gradeToLabel(measurement.pm10Grade, {
        pollutant: "pm10",
        value: measurement.pm10Value
      })
    },
    pm25: {
      value: String(measurement.pm25Value ?? "-"),
      grade: gradeToLabel(measurement.pm25Grade, {
        pollutant: "pm25",
        value: measurement.pm25Value
      })
    },
    khai_grade: measurement.khaiGrade === null || measurement.khaiGrade === undefined || measurement.khaiGrade === ""
      ? "정보없음"
      : gradeToLabel(measurement.khaiGrade, {
        pollutant: "pm10",
        value: measurement.pm10Value
      })
  };
}

async function fetchJson(baseUrl, params, { fetchImpl = global.fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  const url = new URL(baseUrl);
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  url.search = searchParams.toString();
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    if (response.status === 403) {
      throw new Error(
        "AirKorea upstream returned 403 Forbidden. 기술문서 기준 후보 원인: 활용신청 후 동기화 대기(1~2시간), 활용신청하지 않은 API 호출, 서비스키 인코딩/서비스키 오류, 등록하지 않은 도메인 또는 IP.",
      );
    }

    throw new Error(`AirKorea request failed with ${response.status} for ${url}${body ? ` :: ${body.slice(0, 200)}` : ""}`);
  }

  return JSON.parse(await response.text());
}

async function fetchStationLookup({ lat = null, lon = null, regionHint = null, stationName = null, serviceKey, fetchImpl = global.fetch, headers = {}, stationServiceUrl = STATION_SERVICE_URL }) {
  if (!serviceKey) {
    throw new Error("AIR_KOREA_OPEN_API_KEY is not configured on the proxy server.");
  }

  const common = {
    serviceKey,
    returnType: "json",
    numOfRows: 50,
    pageNo: 1
  };

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const { tmX, tmY } = wgs84ToAirKoreaTm(lat, lon);
    const nearbyPayload = await fetchJson(`${stationServiceUrl}/getNearbyMsrstnList`, {
      ...common,
      numOfRows: 10,
      tmX,
      tmY
    }, {
      fetchImpl,
      headers
    });

    if (extractItems(nearbyPayload).length > 0) {
      return {
        lookupMode: "coordinates",
        payload: nearbyPayload
      };
    }
  }

  if (regionHint || stationName) {
    return {
      lookupMode: "fallback",
      payload: await fetchJson(`${stationServiceUrl}/getMsrstnList`, {
        ...common,
        addr: regionHint,
        stationName
      }, {
        fetchImpl,
        headers
      })
    };
  }

  throw new Error("위도/경도 또는 region fallback 이 필요합니다.");
}

async function fetchMeasurementPayload({ stationName, serviceKey, fetchImpl = global.fetch, headers = {}, measurementServiceUrl = MEASUREMENT_SERVICE_URL }) {
  if (!serviceKey) {
    throw new Error("AIR_KOREA_OPEN_API_KEY is not configured on the proxy server.");
  }

  return fetchJson(`${measurementServiceUrl}/getMsrstnAcctoRltmMesureDnsty`, {
    serviceKey,
    returnType: "json",
    numOfRows: 100,
    pageNo: 1,
    stationName,
    dataTerm: "DAILY",
    ver: "1.4"
  }, {
    fetchImpl,
    headers
  });
}

async function fetchFineDustReport({ lat = null, lon = null, regionHint = null, stationName = null, serviceKey, fetchImpl = global.fetch, headers = {}, stationServiceUrl = STATION_SERVICE_URL, measurementServiceUrl = MEASUREMENT_SERVICE_URL }) {
  let stationLookup;
  let stationItems;
  let station;

  try {
    stationLookup = await fetchStationLookup({
      lat,
      lon,
      regionHint,
      stationName,
      serviceKey,
      fetchImpl,
      headers,
      stationServiceUrl
    });
    stationItems = extractItems(stationLookup.payload);
    station = resolveStation(stationItems, {
      lat,
      lon,
      regionHint,
      stationName
    });
  } catch (error) {
    const candidates = buildStationNameCandidates({ stationName, regionHint });
    const canTryMeasurementOnlyFallback =
      String(error?.message || "").includes("403 Forbidden") &&
      candidates.length > 0;

    if (!canTryMeasurementOnlyFallback) {
      throw error;
    }

    for (const candidate of candidates) {
      const measurementPayload = await fetchMeasurementPayload({
        stationName: candidate,
        serviceKey,
        fetchImpl,
        headers,
        measurementServiceUrl
      });
      const measurementItems = extractItems(measurementPayload);

      try {
        const matchedMeasurement = findMeasurement(measurementItems, candidate);
        return buildReport({
          stationItems: [{ stationName: matchedMeasurement.stationName, addr: null }],
          measurementItems,
          lat,
          lon,
          regionHint,
          stationName: matchedMeasurement.stationName,
          lookupMode: "fallback",
          selectedStation: { stationName: matchedMeasurement.stationName, addr: null }
        });
      } catch {
        // try next candidate
      }
    }

    throw error;
  }

  const measurementPayload = await fetchMeasurementPayload({
    stationName: station.stationName,
    serviceKey,
    fetchImpl,
    headers,
    measurementServiceUrl
  });

  return buildReport({
    stationItems,
    measurementItems: extractItems(measurementPayload),
    lat,
    lon,
    regionHint,
    stationName: station.stationName,
    lookupMode: stationLookup.lookupMode,
    selectedStation: station
  });
}

module.exports = {
  GRADE_LABELS,
  STATION_SERVICE_URL,
  MEASUREMENT_SERVICE_URL,
  buildReport,
  extractItems,
  fetchFineDustReport,
  fetchMeasurementPayload,
  fetchStationLookup,
  findMeasurement,
  gradeToLabel,
  pickStation,
  resolveStation,
  toFloat,
  wgs84ToAirKoreaTm
};
