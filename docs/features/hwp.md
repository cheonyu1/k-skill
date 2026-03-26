# HWP 문서 처리 가이드

## 이 기능으로 할 수 있는 일

- `.hwp` 문서를 JSON, Markdown, HTML로 변환
- 문서 안 이미지를 추출
- 폴더 단위 배치 처리
- Windows + 한글 프로그램 설치 환경에서는 직접 문서 조작까지 확장

## 먼저 필요한 것

- 기본 경로: Node.js 18+
- 기본 패키지: `npm install -g @ohah/hwpjs`
- 실행 전: `export NODE_PATH="$(npm root -g)"`
- 직접 제어가 필요할 때만: Windows + 한글(HWP) 프로그램 설치 + Python 3.7+

## 어떤 경로를 선택하나

### 기본값: `@ohah/hwpjs`

다음 상황에서는 `@ohah/hwpjs`를 사용한다.

- macOS / Linux / CI
- 읽기, 변환, 이미지 추출, 배치 처리
- Windows여도 한글 프로그램 설치/연동을 확신할 수 없음

### 예외 경로: `hwp-mcp`

다음 조건을 모두 만족할 때만 `hwp-mcp`를 사용한다.

- Windows
- 한글(HWP) 프로그램이 실제 설치되어 있음
- 문서 생성, 텍스트 삽입, 표 채우기처럼 실행 중인 한글 직접 제어가 필요함

즉, **변환은 `@ohah/hwpjs`, 직접 조작은 `hwp-mcp`** 가 기본 규칙이다.

## 기본 흐름

1. `node -p "process.platform"` 으로 운영체제를 확인한다.
2. `win32` 가 아니면 `@ohah/hwpjs`를 사용한다.
3. `win32` 여도 직접 제어 요건이 분명하지 않으면 `@ohah/hwpjs`를 사용한다.
4. 직접 조작이 필요하고 한글 설치가 확인되면 `hwp-mcp`를 선택한다.
5. 결과 파일 생성 여부와 출력 내용을 확인한다.

## 예시

### JSON 변환

```bash
hwpjs to-json document.hwp -o output.json --pretty
```

### Markdown 변환 + 이미지 포함

```bash
hwpjs to-markdown document.hwp -o output.md --include-images
```

`--include-images` 는 이미지 파일 경로를 따로 만드는 대신 Markdown 안에 base64 `data:` URI로 포함한다.

### HTML 변환

```bash
hwpjs to-html document.hwp -o output.html
```

### 이미지 추출

```bash
hwpjs extract-images document.hwp -o ./images
```

### 배치 처리

```bash
hwpjs batch ./documents -o ./output --format json --recursive
```

## 직접 제어가 필요한 경우

`hwp-mcp`는 Windows + 한글 프로그램 설치 환경에서만 고려한다.

```bash
git clone https://github.com/jkf87/hwp-mcp.git
cd hwp-mcp
pip install -r requirements.txt
```

그 뒤 MCP 서버로 연결해 새 문서 생성, 텍스트 삽입, 표 작성, 저장 같은 작업을 수행한다.

## 주의할 점

- `hwp-mcp`를 Linux/macOS에서 우회 실행하려 하지 않는다.
- 직접 제어 필요성이 약하면 `@ohah/hwpjs`로 바로 끝내는 편이 더 안정적이다.
- 배치 작업 후에는 입력 개수와 출력 개수를 같이 확인한다.
