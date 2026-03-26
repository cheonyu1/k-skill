---
name: hwp
description: Convert HWP files to JSON, Markdown, or HTML, extract images, and choose between @ohah/hwpjs and hwp-mcp based on OS and local Hangul availability.
license: MIT
metadata:
  category: documents
  locale: ko-KR
  phase: v1
---

# HWP

## What this skill does

`.hwp` 문서를 읽어 JSON / Markdown / HTML로 변환하고, 이미지 추출이나 배치 처리를 수행한다.  
환경이 **Windows + 한글(HWP) 프로그램 설치 + 직접 제어가 필요한 작업**이면 `hwp-mcp`를 선택하고, 그 외에는 기본값으로 `@ohah/hwpjs`를 사용한다.

## When to use

- "이 HWP 파일을 Markdown으로 바꿔줘"
- "한글 문서에서 이미지만 뽑아줘"
- "폴더 안 HWP를 한 번에 JSON으로 변환해줘"
- "윈도우에서 한글 프로그램을 직접 조작해서 표 채워줘"

## When not to use

- 원본이 `.hwpx`, `.docx`, `.pdf` 인 경우
- Windows가 아니거나 한글 프로그램이 없는데 직접 편집 자동화를 요구하는 경우
- OCR이나 스캔 PDF 복구가 필요한 경우

## Prerequisites

- 공통 변환 경로: Node.js 18+
- 직접 제어 경로: Windows + 한글(HWP) 프로그램 설치 + Python 3.7+
- 출력 경로 쓰기 권한

## Inputs

- 원본 `.hwp` 파일 경로 또는 폴더 경로
- 원하는 출력 형식: `json`, `markdown`, `html`
- 출력 파일/디렉터리 경로
- 이미지 포함/추출 여부
- 배치 처리 여부
- 직접 제어가 필요한지 여부

## Routing policy

### Default: `@ohah/hwpjs`

다음 조건 중 하나라도 맞으면 `@ohah/hwpjs`를 기본값으로 사용한다.

- macOS / Linux / CI 환경
- Windows여도 한글 프로그램 설치 여부를 확신할 수 없음
- 읽기 / 변환 / 이미지 추출 / 배치 처리 중심 작업

### Windows direct-control path: `hwp-mcp`

다음 조건을 모두 만족할 때만 `hwp-mcp`를 선택한다.

- 운영체제가 Windows
- 한글(HWP) 프로그램이 실제로 설치되어 있음
- 문서 생성, 텍스트 삽입, 표 채우기, 저장 같은 **실행 중인 한글 프로그램 직접 제어**가 필요함

직접 제어 조건이 불분명하면 추측하지 말고 `@ohah/hwpjs`로 처리 가능한 범위부터 진행한다.

## Workflow

### 0. Detect the environment first

```bash
node -p "process.platform"
```

- 결과가 `win32`가 아니면 `@ohah/hwpjs`
- 결과가 `win32`여도 한글 프로그램 직접 제어가 확인되지 않으면 `@ohah/hwpjs`
- `win32` 이고 한글 프로그램이 실제로 설치되어 있으며 직접 조작이 필요하면 `hwp-mcp`

### 1. Install the chosen backend when missing

#### `@ohah/hwpjs`

```bash
npm install -g @ohah/hwpjs
export NODE_PATH="$(npm root -g)"
```

#### `hwp-mcp`

```bash
git clone https://github.com/jkf87/hwp-mcp.git
cd hwp-mcp
pip install -r requirements.txt
```

`hwp-mcp`는 Windows와 한글 프로그램 설치가 전제다. 이 전제가 깨지면 억지로 진행하지 말고 `@ohah/hwpjs`로 되돌린다.

### 2. Prefer `@ohah/hwpjs` for conversions and extraction

#### JSON 변환

```bash
hwpjs to-json document.hwp -o output.json --pretty
```

#### Markdown 변환

```bash
hwpjs to-markdown document.hwp -o output.md --include-images
```

`--include-images` 는 이미지를 별도 파일로 떨구지 않고 Markdown 안에 base64 `data:` URI로 인라인한다.

#### HTML 변환

```bash
hwpjs to-html document.hwp -o output.html
```

#### 이미지 추출

```bash
hwpjs extract-images document.hwp -o ./images
```

#### 배치 처리

```bash
hwpjs batch ./documents -o ./output --format json --recursive
```

배치 출력 형식은 로컬 설치 버전의 `hwpjs batch --help` 를 확인해 맞춘다.

### 3. Use `hwp-mcp` only for live HWP control on Windows

Claude/Codex MCP 설정에 `hwp_mcp_stdio_server.py` 를 등록한 뒤 다음 종류의 작업에 사용한다.

- 새 문서 생성
- 텍스트 삽입
- 표 생성 / 채우기
- 저장
- 여러 편집 명령을 묶은 배치 작업

직접 제어 예시는 다음 범주에 한정한다.

- 보고서 템플릿 채우기
- 표 데이터 입력
- 정해진 서식 문서 생성

### 4. Verify outputs after every run

- JSON: 파일 생성 여부와 최상위 구조 확인
- Markdown: 본문 생성 여부와 `data:` URI / base64 이미지 인라인 포함 여부 확인 (`--include-images` 사용 시)
- HTML: 파일 생성 후 브라우저 렌더링 가능 여부 확인
- 이미지 추출: 출력 디렉터리에 파일이 실제로 생겼는지 확인
- 배치 처리: 입력 개수와 출력 개수가 대략 맞는지 확인

## Done when

- 요청한 형식의 결과물이 생성되어 있다
- 이미지 요청이 있으면 추출 파일 또는 Markdown 안 `data:` URI 인라인 결과가 확인되어 있다
- 배치 요청이면 처리 범위와 실패 건수가 정리되어 있다
- Windows 직접 제어 작업이면 어떤 조작을 수행했는지 남아 있다

## Failure modes

- 손상된 `.hwp` 파일
- 전역 `hwpjs` 미설치
- Windows가 아니어서 `hwp-mcp`를 사용할 수 없음
- 한글 프로그램 미설치 또는 자동화 연결 실패
- 출력 디렉터리 권한 부족

## Notes

- 기본 선택지는 언제나 `@ohah/hwpjs`다.
- `hwp-mcp`는 Windows + 한글 설치 환경에서만 직접 제어용으로 사용한다.
- 직접 제어가 실패해도 읽기/변환 작업으로 충분하면 `@ohah/hwpjs` 경로로 축소해 완료한다.
