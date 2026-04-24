---
name: joongna-search
description: Use k-skill-proxy to search secondhand products on Joongna (중고나라) without requiring the user to visit the website directly.
license: MIT
metadata:
  category: marketplace
  locale: ko-KR
  phase: v1
---

# Joongna Search

## What this skill does

`https://k-skill-proxy.nomadamas.org/v1/joongna/search` 로 요청해서 중고나라에서 중고 상품을 검색한다.

upstream 중고나라 웹사이트는 공개 REST API를 제공하지 않으므로, proxy 서버에서 SSR HTML을 가져와 Next.js RSC 페이로드를 파싱하는 방식으로 동작한다. 사용자는 별도 설정 없이 검색만 하면 된다.

## When to use

- "중고나라에서 오즈모 액션5프로 어드벤처 검색해줘"
- "중고나라 아이폰16 프로맥스 매물 좀 찾아줘"
- "중고나라 갤럭시 S25 울트라 싼 거 찾아봐"
- "중고나라 에어팟 프로2 올라온 거 있어?"

## When not to use

- 번개장터, 당근마켓, 네이버 중고장터 검색 (각각 bunjang-search 등 별도 스킬 사용)
- 중고나라 판매글 직접 등록/수정/삭제
- 채팅/거래/결제 자동화

## Prerequisites

없음. 사용자는 별도 API 키나 계정이 필요하지 않다.

## Default path

`KSKILL_PROXY_BASE_URL` 환경변수가 있으면 그 값을 사용하고, 없으면 기본 경로 `https://k-skill-proxy.nomadamas.org` 를 사용한다.

## Supported endpoints

### 상품 검색

```http
GET /v1/joongna/search?q={검색어}&quantity={결과수}&page={페이지}&sort={정렬}
```

### Query parameters

| 파라미터 | 필수 | 기본값 | 설명 |
|-----------|------|--------|------|
| `q` | O | - | 검색어 (2자 이상) |
| `quantity` | X | 20 | 결과 수 (1~50) |
| `page` | X | 0 | 페이지 번호 (0부터 시작) |
| `sort` | X | RECOMMEND_SORT | 정렬: RECOMMEND_SORT, RECENT_SORT, PRICE_ASC_SORT, PRICE_DESC_SORT |
| `minPrice` | X | 0 | 최소 가격 |
| `maxPrice` | X | 100000000 | 최대 가격 |

### Example requests

```bash
curl -fsS --get 'https://k-skill-proxy.nomadamas.org/v1/joongna/search' \
  --data-urlencode 'q=오즈모 액션5프로 어드벤처' \
  --data-urlencode 'quantity=10'

curl -fsS --get 'https://k-skill-proxy.nomadamas.org/v1/joongna/search' \
  --data-urlencode 'q=아이폰16 프로맥스' \
  --data-urlencode 'quantity=5' \
  --data-urlencode 'sort=PRICE_ASC_SORT' \
  --data-urlencode 'minPrice=500000' \
  --data-urlencode 'maxPrice=1500000'
```

## Response shape

```json
{
  "items": [
    {
      "rank": 1,
      "product_id": 265123456,
      "title": "DJI 오즈모 액션 5 프로 어드벤처 콤보",
      "price": 520000,
      "price_text": "520,000원",
      "location": "경기도 광주시 초월읍",
      "locations": ["경기도 광주시 초월읍"],
      "image_url": "https://...",
      "wish_count": 4,
      "chat_count": 1,
      "parcel_fee": "유료",
      "jn_pay": false,
      "certified_seller": false,
      "sort_date": "2025-07-10T14:30:00",
      "product_url": "https://web.joongna.com/product/265123456",
      "source": "joongna-rsc"
    }
  ],
  "query": {
    "q": "오즈모 액션5프로 어드벤처",
    "quantity": 10,
    "page": 0,
    "sort": "RECOMMEND_SORT"
  },
  "meta": {
    "query": "오즈모 액션5프로 어드벤처",
    "extraction": "joongna-rsc",
    "item_count": 5
  },
  "upstream": {
    "url": "https://web.joongna.com/search/...",
    "status_code": 200,
    "content_type": "text/html; charset=utf-8",
    "provider": "joongna-rsc"
  },
  "proxy": {
    "name": "k-skill-proxy",
    "cache": { "hit": false, "ttl_ms": 300000 },
    "requested_at": "2025-07-10T15:00:00.000Z"
  }
}
```

## Response fields

| 필드 | 설명 |
|------|------|
| `product_id` | 중고나라 상품 번호 |
| `title` | 상품 제목 |
| `price` | 가격 (숫자) |
| `price_text` | 가격 (포맷된 문자열) |
| `location` | 대표 지역 |
| `locations` | 전체 지역 목록 |
| `image_url` | 썸네일 이미지 URL |
| `wish_count` | 찜 수 |
| `chat_count` | 채팅 수 |
| `parcel_fee` | 배송비 유무 ("유료"/"무료"/null) |
| `jn_pay` | 중고나라 페이 여부 |
| `certified_seller` | 인증 판매자 여부 |
| `sort_date` | 정렬 기준 시간 |
| `product_url` | 중고나라 상품 페이지 URL |

## Response policy

- 검색 결과는 제목/가격/지역 중심으로 1차 요약한다.
- 가격대가 비정상적이거나 의심스러운 매물은 주의 표시를 한다.
- 같은 상품이 여러 번 검색되면 중복 제거한다.
- 판매완료된 매물은 응답에 포함되지 않을 수 있다.
- 결과가 없으면 "해당 검색어로 등록된 매물이 없다"고 안내한다.
- 필요하면 검색어를 더 구체적으로 좁히라고 제안한다.

## Keep the answer compact

- 제목 / 가격 / 지역 / 찜·채팅 수
- 배송비 유무, 중고나라 페이 여부
- 인증 판매자면 강조
- 상위 5~10개만 보여주고 더 보고 싶으면 page 증가 안내

## Failure modes

- `q` 가 없거나 2자 미만이면 400 응답
- 중고나라 upstream 서버 장애 시 502 응답
- RSC 파싱 실패 시 빈 `items` 배열과 `meta.extraction: "none"` 반환
- 캐시 히트 시 `proxy.cache.hit: true`

## Limitations

- 중고나라는 공개 API가 없어 SSR HTML 파싱 방식을 사용한다. 중고나라 웹사이트 구조가 변경되면 파싱이 실패할 수 있다.
- 검색 결과는 추천 정렬 기준 상위 매물만 보여준다. 전체 매물을 보려면 직접 중고나라 웹사이트를 방문해야 한다.
- 판매 상태(판매중/판매완료)가 실시간으로 반영되지 않을 수 있다.

## Done when

- 검색어에 맞는 중고나라 매물을 가격/지역/상태 중심으로 정리했다.
- 각 매물의 product_url 을 제공해 사용자가 직접 확인할 수 있게 했다.
- 결과가 없으면 대체 검색어나 직접 방문을 안내했다.
