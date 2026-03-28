# k-skill-proxy

`k-skill`용 Fastify 기반 프록시 서버입니다. 지금은 AirKorea 미세먼지 조회를 먼저 감싸고, 이후 무료/공공 API adapter를 추가하는 베이스로 씁니다.

## 현재 제공 엔드포인트

- `GET /health`
- `GET /v1/fine-dust/report`

## 환경변수

- `AIR_KOREA_OPEN_API_KEY` — 프록시 서버 쪽 AirKorea upstream key
- `KSKILL_PROXY_HOST` — 기본 `127.0.0.1`
- `KSKILL_PROXY_PORT` — 기본 `4020`
- `KSKILL_PROXY_CACHE_TTL_MS` — 기본 `300000`
- `KSKILL_PROXY_RATE_LIMIT_WINDOW_MS` — 기본 `60000`
- `KSKILL_PROXY_RATE_LIMIT_MAX` — 기본 `60`

기본 정책은 **무료 API 공개 프록시 = 무인증** 이다. 대신 endpoint scope 를 좁게 유지하고, cache + rate limit 으로 남용을 늦춘다.

## 로컬 실행

```bash
SOPS_AGE_KEY_FILE="$HOME/.config/k-skill/age/keys.txt" \
sops exec-env "$HOME/.config/k-skill/secrets.env" \
  'node packages/k-skill-proxy/src/server.js'
```

## PM2 실행

루트의 `ecosystem.config.cjs` + `scripts/run-k-skill-proxy.sh` 조합을 사용하면 재부팅 이후에도 같은 encrypted secrets 경로로 다시 올라옵니다.
