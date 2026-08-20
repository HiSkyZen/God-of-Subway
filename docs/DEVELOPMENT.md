# 로컬 개발

## 요구사항

- Bun 1.3.14 이상
- TypeScript는 `devDependencies` 버전을 사용

```bash
bun install
bun run doctor
bun run dev
```

`doctor`는 `data/`의 핵심 JSON 데이터셋 존재 여부와 바이트 크기, 환승 데이터 버전을 먼저 확인합니다. 데이터 파일을 바꾸면 `src/engine/data-metadata.ts`의 크기도 같이 갱신해야 합니다.

## 검증

```bash
bun run check
```

`check`는 데이터 doctor → TypeScript → service worker TypeScript → push architecture → Bun tests 순서로 실행합니다.

개별 데이터 감사:

```bash
bun run audit:transfers
```

## 모듈 추가 원칙

- 철도 규칙은 `src/engine`에 둡니다.
- UI 표시 규칙은 `src/client`에 둡니다.
- 캐시/푸시/관측성은 `src/infra`에 둡니다.
- 정적 데이터셋은 `data/`에 두고 루트에 개별 JSON을 늘어놓지 않습니다.
- 데이터 파일의 파생 규칙을 JSON 자체에 무분별하게 섞지 말고, provenance가 필요한 보정은 정책 모듈 또는 감사 가능한 생성 스크립트로 둡니다.
