# 사용자 위치 미세먼지 조회 가이드

## 이 기능으로 할 수 있는 일

- 사용자 위치 위도/경도로 가까운 측정소 찾기
- 위치 권한이 없을 때 지역명/행정구역 fallback으로 측정소 찾기
- PM10, PM2.5, 등급, 조회 시각 요약

## 먼저 필요한 것

- [공통 설정 가이드](../setup.md) 완료
- [보안/시크릿 정책](../security-and-secrets.md) 확인
- `k-skill-proxy` 또는 에어코리아 OpenAPI key

## 필요한 시크릿

클라이언트 기본값:

- 기본 external proxy URL: `https://k-skill-proxy.nomadamas.org`
- `KSKILL_PROXY_BASE_URL` 는 override 가 필요할 때만 사용

프록시 없이 direct fallback 으로 쓸 때만:

- `AIR_KOREA_OPEN_API_KEY`

## 입력값

- 우선: 현재 위치 위도/경도(WGS84)
- fallback: 지역명/행정구역 힌트 또는 측정소명

## 기본 흐름

1. `KSKILL_PROXY_BASE_URL` 가 있으면 먼저 `k-skill-proxy` 의 `/v1/fine-dust/report` endpoint 를 호출합니다.
2. 프록시가 없을 때만 입력 위도/경도(WGS84)를 에어코리아 nearby 조회가 요구하는 **TM 좌표(중부원점)** 로 먼저 변환합니다.
3. 변환된 `tmX`/`tmY` 로 측정소정보 API `getNearbyMsrstnList` 를 호출해 가까운 측정소를 찾습니다.
4. 좌표를 못 받거나 nearby 결과가 비면 측정소정보 API `getMsrstnList` 로 지역명/행정구역 fallback을 사용합니다.
5. 선택된 측정소 이름으로 대기오염정보 API `getMsrstnAcctoRltmMesureDnsty` 를 호출합니다.
6. PM10, PM2.5, 등급, 조회 시점/조회 시각을 함께 요약합니다.

프록시 예시:

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/k-skill/age/keys.txt" \
sops exec-env "$HOME/.config/k-skill/secrets.env" \
  'python3 scripts/fine_dust.py report --region-hint "서울 강남구" --json'
```

원본 AirKorea endpoint 형태를 거의 그대로 쓰고 싶으면 passthrough endpoint 도 사용할 수 있습니다. 별도 client API 는 불필요하고, 프록시가 `serviceKey` 만 서버에서 주입합니다.

```bash
curl -fsS --get 'https://k-skill-proxy.nomadamas.org/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty' \
  --data-urlencode 'returnType=json' \
  --data-urlencode 'numOfRows=1' \
  --data-urlencode 'pageNo=1' \
  --data-urlencode 'stationName=강남구' \
  --data-urlencode 'dataTerm=DAILY' \
  --data-urlencode 'ver=1.4'
```

## 예시

좌표 기반 1차 조회:

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/k-skill/age/keys.txt" \
sops exec-env "$HOME/.config/k-skill/secrets.env" \
  'curl -sG "http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getNearbyMsrstnList" \
    --data-urlencode "serviceKey=${AIR_KOREA_OPEN_API_KEY}" \
    --data-urlencode "returnType=json" \
    --data-urlencode "numOfRows=10" \
    --data-urlencode "pageNo=1" \
    --data-urlencode "tmX=198245.053183" \
    --data-urlencode "tmY=451586.837879"'
```

`getNearbyMsrstnList` 는 WGS84 위도/경도를 직접 받지 않습니다. helper script 는 `37.5665, 126.9780` 같은 입력을 위 값처럼 TM 좌표로 변환한 뒤 nearby API 를 호출합니다. 같은 기술문서에는 읍면동 기준 `getTMStdrCrdnt` 도 정의돼 있지만, 이 스킬은 사용자 위치 입력이 WGS84 라는 점 때문에 로컬 변환 후 `tmX`/`tmY` 를 사용합니다.

지역 fallback:

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/k-skill/age/keys.txt" \
sops exec-env "$HOME/.config/k-skill/secrets.env" \
  'curl -sG "http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getMsrstnList" \
    --data-urlencode "serviceKey=${AIR_KOREA_OPEN_API_KEY}" \
    --data-urlencode "returnType=json" \
    --data-urlencode "numOfRows=50" \
    --data-urlencode "pageNo=1" \
    --data-urlencode "addr=서울 강남구"'
```

실시간 측정값:

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/k-skill/age/keys.txt" \
sops exec-env "$HOME/.config/k-skill/secrets.env" \
  'curl -sG "http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty" \
    --data-urlencode "serviceKey=${AIR_KOREA_OPEN_API_KEY}" \
    --data-urlencode "returnType=json" \
    --data-urlencode "numOfRows=100" \
    --data-urlencode "pageNo=1" \
    --data-urlencode "stationName=중구" \
    --data-urlencode "dataTerm=DAILY" \
    --data-urlencode "ver=1.4"'
```

helper script 반복 검증:

```bash
python3 scripts/fine_dust.py report \
  --station-file scripts/fixtures/fine-dust-stations.json \
  --measurement-file scripts/fixtures/fine-dust-measurements.json \
  --lat 37.5665 \
  --lon 126.9780
```

## fallback / 대체 흐름

- 위치 권한이 없으면 지역명/행정구역을 먼저 받습니다
- 지역명도 없으면 측정소명을 직접 받습니다
- 측정소 목록 API가 빈 응답이어도 `--station-name` 이 있으면 같은 이름으로 실시간 측정 API를 직접 재시도합니다
- `getNearbyMsrstnList` 결과가 비면 `getMsrstnList` 로 재시도합니다
- nearby 응답은 입력 TM 좌표와의 거리 기준으로 정렬되므로 첫 측정소를 우선 사용합니다

## 주의할 점

- 실시간 수치라 조회 시각을 같이 적어야 합니다
- PM10/PM2.5 값이 `-` 이거나 비정상이면 등급도 함께 재확인합니다
- API 가 `khaiGrade` 를 비워 보내면 통합대기등급은 `정보없음` 으로 표시합니다
- 위치 기반이라고 해도 실제 기준은 “가까운 측정소” 이므로 주소 중심점과 오차가 있을 수 있습니다
- hosted 모드에서는 upstream AirKorea key 를 클라이언트에 배포하지 않고 proxy 에만 둡니다
