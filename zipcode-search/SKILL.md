---
name: zipcode-search
description: Look up a Korean postcode from a known address with the official ePost road-name search page. Use when the user knows the address but wants the postal code quickly.
license: MIT
metadata:
  category: utility
  locale: ko-KR
  phase: v1
---

# Zipcode Search

## What this skill does

우체국 공식 도로명주소 검색 페이지를 조회해서 주소 키워드에 맞는 우편번호를 빠르게 찾는다.

## When to use

- "이 주소 우편번호 뭐야"
- "세종대로 209 우편번호 찾아줘"
- "판교역로 235 주소 코드만 빨리 알려줘"

## Prerequisites

- 인터넷 연결
- 선택 사항: `python3`

## Inputs

- 주소 키워드
  - 도로명 + 건물번호
  - 시/군/구 + 도로명
  - 동/리 + 지번

## Workflow

### 1. Query the official ePost page first

비공식 지도 검색이나 블로그 주소 데이터로 우회하지 말고 아래 우체국 공식 검색 페이지를 먼저 조회한다.

```text
https://parcel.epost.go.kr/parcel/comm/zipcode/comm_newzipcd_list.jsp
```

요청은 `keyword` 파라미터 하나만으로도 동작한다.

### 2. Fetch the HTML and extract the candidate rows

```bash
python3 - <<'PY'
import html
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen

query = "세종대로 209"
url = "https://parcel.epost.go.kr/parcel/comm/zipcode/comm_newzipcd_list.jsp?" + urlencode({"keyword": query})
request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "ko,en;q=0.8"})

with urlopen(request, timeout=20) as response:
    page = response.read().decode("utf-8", "ignore")

matches = re.findall(
    r'name="sch_zipcode"\s+value="([^"]+)".*?name="sch_address1"\s+value="([^"]+)".*?name="sch_bdNm"\s+value="([^"]*)"',
    page,
    re.S,
)

if not matches:
    raise SystemExit("검색 결과가 없습니다.")

for zip_code, address, building in matches[:5]:
    suffix = f" ({building})" if building else ""
    print(f"{zip_code}\t{html.unescape(address)}{suffix}")
PY
```

핵심 필드는 `sch_zipcode`(우편번호), `sch_address1`(기본 주소), `sch_bdNm`(건물명)이다.

### 3. Normalize for humans

응답은 raw HTML이므로 그대로 붙이지 말고 아래처럼 정리한다.

- 우편번호
- 표준 주소
- 건물명이 있으면 함께 표기
- 후보가 여러 개면 상위 3~5개만 보여주고 어느 항목이 가장 근접한지 짚기

### 4. Retry with a tighter keyword when needed

검색 결과가 없으면 키워드를 더 짧고 정확하게 바꿔 다시 조회한다.

- `세종대로 209`
- `서울 종로구 세종대로 209`
- `세종로 209`

## Done when

- 적어도 한 개의 우편번호 후보가 정리되어 있다
- 다중 후보일 때 사용자가 고를 수 있게 주소 차이가 보인다
- 검색 결과가 없으면 재검색 키워드 방향을 제안했다

## Failure modes

- 우체국 검색 페이지 마크업이 바뀌면 `sch_zipcode` 추출 규칙이 깨질 수 있다
- 주소 키워드가 너무 넓으면 결과가 과하게 많아질 수 있다

## Notes

- 조회형 스킬이다
- 상대 날짜/실시간 개념은 없으므로 주소 문자열 정제에 집중한다
