# 쿠팡 상품 검색 가이드

## 이 기능으로 할 수 있는 일

[coupang-mcp](https://github.com/uju777/coupang-mcp) 서버를 통해 쿠팡 상품을 검색하고 실시간 가격을 확인한다.

- 키워드 상품 검색 (로켓배송/일반배송 구분)
- 로켓배송 전용 필터 검색
- 가격대 범위 검색
- 상품 비교표 생성
- 카테고리별 베스트 상품, 골드박스 당일 특가
- 인기 검색어/계절 상품 추천

## 동작 방식

```
Claude Code → MCP JSON-RPC → HF Space (coupang-mcp) → Netlify 프록시 (도쿄) → 다나와/쿠팡
```

- **API 키 불필요** — coupang-mcp가 다나와 가격 조회를 1차로, 쿠팡 API를 폴백으로 사용
- 해외 IP 차단 우회를 위해 도쿄 리전 Netlify 프록시 경유

## MCP 엔드포인트

```
https://yuju777-coupang-mcp.hf.space/mcp
```

프로토콜: MCP Streamable HTTP (JSON-RPC 2.0)

## 사용 가능한 도구

| 도구명 | 기능 | 사용 예시 |
|--------|------|----------|
| `search_coupang_products` | 일반 상품 검색 | "맥북 검색해줘" |
| `search_coupang_rocket` | 로켓배송만 필터링 | "로켓배송 에어팟 찾아줘" |
| `search_coupang_budget` | 가격대 범위 검색 | "10만원 이하 키보드" |
| `compare_coupang_products` | 상품 비교표 생성 | "아이패드 vs 갤럭시탭" |
| `get_coupang_recommendations` | 인기 검색어 제안 | "요즘 뭐가 인기야?" |
| `get_coupang_seasonal` | 계절/상황별 추천 | "설날 선물 추천" |
| `get_coupang_best_products` | 카테고리별 베스트 | "전자제품 베스트" |
| `get_coupang_goldbox` | 당일 특가 정보 | "오늘 특가 뭐있어?" |

## 기본 흐름

1. 검색어를 받는다. 너무 넓으면 용도/예산/브랜드를 먼저 물어본다.
2. MCP 세션을 초기화한다 (`initialize` → `Mcp-Session-Id` 확보).
3. `tools/call`로 적절한 도구를 호출한다.
4. 결과를 로켓배송/일반배송으로 구분하여 정리한다.
5. 상위 3~5개 추천과 함께 가격/배송 정보를 제공한다.

## 호출 예시

```bash
# 1. 세션 초기화
curl -s -X POST "https://yuju777-coupang-mcp.hf.space/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2025-03-26",
    "capabilities":{},
    "clientInfo":{"name":"k-skill","version":"1.0"}
  }}'
# → 응답 헤더에서 Mcp-Session-Id 확보

# 2. 상품 검색
curl -s -X POST "https://yuju777-coupang-mcp.hf.space/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
    "name":"search_coupang_products",
    "arguments":{"keyword":"생수"}
  }}'
```

## 결과 형식

```
## rocket (6)

1) LG전자 4K UHD 모니터
   옵션: 80cm / 32UR500K
   가격: 397,750원 (39만원대)
   보러가기: https://link.coupang.com/a/...

## normal (4)

1) 삼성전자 QHD 오디세이 G5 게이밍 모니터
   가격: 283,000원 (28만원대)
   보러가기: https://link.coupang.com/a/...
```

## 제한사항

- 가격은 참고용이다. 다나와 조회 실패 시 쿠팡 API 추정가가 표시된다.
- 로그인, 장바구니, 결제 자동화는 지원하지 않는다.
- MCP 서버(HF Space)가 다운되면 일시적으로 사용 불가하다.

## 출처

- [coupang-mcp GitHub](https://github.com/uju777/coupang-mcp)
- MCP 엔드포인트: `https://yuju777-coupang-mcp.hf.space/mcp`
