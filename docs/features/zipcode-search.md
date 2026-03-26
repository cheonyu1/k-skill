# 우편번호 검색 가이드

## 이 기능으로 할 수 있는 일

- 주소 키워드로 공식 우체국 우편번호 조회
- 같은 도로명/건물명 후보가 여러 개일 때 상위 결과 비교
- 검색 결과가 없을 때 바로 재검색 키워드 조정

## 먼저 필요한 것

- 인터넷 연결
- 선택 사항: `python3`

## 입력값

- 주소 키워드
  - 예: `세종대로 209`
  - 예: `판교역로 235`

## 기본 흐름

1. 비공식 지도/블로그 검색으로 우회하지 말고 우체국 공식 검색 페이지를 먼저 조회합니다.
2. 주소 키워드를 `keyword` 파라미터로 넘겨 HTML 결과를 받습니다.
3. 결과에서 우편번호(`sch_zipcode`)와 표준 주소(`sch_address1`)를 추출합니다.
4. 후보가 여러 개면 상위 3~5개만 간단히 비교해 줍니다.
5. 검색 결과가 없으면 키워드를 도로명 + 건물번호 또는 동/리 + 지번 형태로 다시 줄여서 재시도합니다.

## 예시

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

## 주의할 점

- 같은 번지라도 건물명에 따라 여러 행이 나올 수 있으니 첫 결과만 바로 확정하지 않습니다.
- 결과가 너무 많으면 시/군/구를 포함해 검색어를 더 구체화합니다.
- 조회형 스킬이므로 개인정보를 저장하지 않습니다.
