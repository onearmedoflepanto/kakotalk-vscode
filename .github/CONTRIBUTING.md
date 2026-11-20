# 개발과 배포

설치 사용법은 루트 README에 있습니다. 소스 저장소에는 `src`, `media`, `tools`, `tests`와 빌드 설정을 보관합니다. VSIX와 배포 ZIP은 GitHub Releases에 올립니다.

## 로컬 빌드

Windows x64, Node.js 24, Python 3.12.10 x64가 필요합니다. 준비된 Python 환경에서 저장소 루트를 기준으로 실행합니다.

```powershell
npm ci
python -m pip install -r tools/requirements-build.txt
npm test
npm run build
npm run test:package
```

Python을 직접 지정하려면 다음과 같이 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1 -PythonPath "D:\Python312\python.exe"
```

빌드 산출물은 다음 위치에 생성됩니다.

- `kakao-local-chat-버전-win32-x64.vsix`
- `.generated/releases/local-chat-버전-win32-x64.zip`
- `.generated/releases/local-chat-버전-win32-x64.zip.sha256`
- `.generated/releases/bin/local-chat-worker.exe`

`npm test`는 기존 회귀 검사를, `npm run test:package`는 실제 배포 ZIP과 내장 실행 파일의 연결을 검사합니다. 이 검사는 PC카톡에 연결하거나 메시지를 보내지 않습니다. 실제 클라이언트 검증용 `tools/validate-*.cjs`는 대상 PC에서 별도로 실행합니다.

답장 검증은 `.generated` 아래의 JSON 파일로 대상 정보를 받습니다. 형식은 `pid`, `roomId`, `roomTitle`, `replyTo: { id, senderId }`, `text`이며, 이 파일은 저장소에 포함하지 않습니다.

```powershell
node tools/validate-reply.cjs --request .generated/reply-request.json
```

`--send`를 추가하면 지정한 문구를 실제로 발송하므로 대상과 내용을 먼저 확인합니다. 기본 실행은 답장 대상만 선택합니다.

## GitHub Actions

`Windows build` 워크플로는 push, pull request, 수동 실행에서 의존성 설치, 회귀 검사, PyInstaller 빌드, 패키지 검사를 수행합니다. 성공한 ZIP과 SHA-256 파일은 실행 결과의 `local-chat-windows-x64` artifact에서 받을 수 있습니다.

정식 배포는 `package.json` 버전과 같은 `vX.Y.Z` 태그를 push합니다. 예를 들어 버전이 `0.3.7`이면 태그는 `v0.3.7`입니다. 검사와 빌드가 성공하면 해당 태그의 GitHub Release에 ZIP과 SHA-256 파일을 등록합니다. 수동 실행과 일반 브랜치 push는 Release를 게시하지 않습니다.

Release 작업만 `contents: write`를 사용합니다. 별도 PAT를 저장할 필요 없이 워크플로의 `GITHUB_TOKEN`을 사용합니다. 조직 정책이 Actions 또는 Release 작성을 제한하면 저장소 관리자가 해당 권한을 설정해야 합니다.

의존성은 `package-lock.json`과 `tools/requirements-build.txt`에서 관리하고 GitHub Actions는 검토한 commit SHA에 고정합니다. 의존성을 바꿀 때는 패키지 검사까지 다시 실행합니다.

프로젝트의 라이선스 표기는 현재 `UNLICENSED`입니다. 배포 EXE에 포함되는 Python, Frida, PyInstaller의 라이선스는 VSIX의 `licenses` 폴더에 포함합니다.
