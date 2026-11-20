# Local Chat 설치

Windows x64와 VS Code 1.85 이상(1.x, x64)이 필요합니다. 실행 파일이 패키지에 포함되어 있어 Python·Node.js를 따로 설치하지 않아도 됩니다.

1. GitHub 저장소의 **Releases**에서 `local-chat-버전-win32-x64.zip`을 받아 압축을 풉니다. `Source code (zip)`은 설치용 파일이 아닙니다. `install.ps1`과 `.vsix` 파일을 같은 폴더에 둡니다.
2. 해당 폴더에서 PowerShell을 열고 실행합니다. 관리자 권한은 필요하지 않습니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. 설치가 끝나면 VS Code를 다시 실행합니다. PC카톡에 로그인한 뒤 `Ctrl+Shift+P`에서 `카카오톡: 창 열기`를 실행합니다.

PC카톡 26.9.2.5342 x64를 지원합니다. 메시지를 보내려면 VS Code 설정에서 `Local Chat: Enable Sending`을 켭니다.

VS Code를 자동으로 찾지 못하면 실행 파일 경로를 지정합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CodePath "D:\Apps\Microsoft VS Code\Code.exe"
```

설치 가능 여부만 확인하려면 `-CheckOnly`를 붙입니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly
```

업데이트도 배포 ZIP을 압축 해제한 뒤 같은 명령을 실행합니다. VSIX를 직접 지정할 때는 `-VsixPath "파일 경로"`를 사용합니다. 별도 VS Code 데이터 폴더에 설치하려면 `-UserDataDir "폴더 경로" -ExtensionsDir "폴더 경로"`를 함께 지정합니다.
