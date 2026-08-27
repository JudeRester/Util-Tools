@echo off
chcp 65001 > nul
title Util-Tools Distribution Builder

echo ========================================================
echo   🚀 Util-Tools Desktop Package Builder (PyInstaller)
echo ========================================================
echo.

:: 1. 의존성 패키지 확인 및 설치
echo [1/3] 필수 패키지 및 PyInstaller 상태 확인 중...
python -m pip install -q -r requirements.txt pyinstaller
if %errorlevel% neq 0 (
    echo [경고] pip 설치 중 오류가 발생했으나 기존 설치 환경으로 계속 진행합니다.
)

:: 2. 이전 빌드 산출물 정리
echo [2/3] 이전 빌드 임시 파일 정리 중...
if exist "dist\UtilTools" (
    echo       - dist\UtilTools 폴더 정리...
    rd /s /q "dist\UtilTools" 2>nul
)
if exist "build" (
    echo       - build 임시 폴더 정리...
    rd /s /q "build" 2>nul
)

:: 3. PyInstaller 빌드 실행
echo [3/3] UtilTools 독립 실행 패키지 빌드 시작 (UtilTools.spec)...
echo.
pyinstaller --noconfirm UtilTools.spec

if %errorlevel% neq 0 (
    echo.
    echo ❌ [오류] 패키징 빌드에 실패했습니다! 오류 메시지를 확인해 주세요.
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================================
echo 🎉 [빌드 성공] 패키징이 성공적으로 완료되었습니다!
echo.
echo 📁 배포 폴더 경로:
echo    %~dp0dist\UtilTools\
echo.
echo 🚀 실행 파일:
echo    %~dp0dist\UtilTools\UtilTools.exe
echo.
echo 💡 dist\UtilTools 폴더를 그대로 압축하여 배포하거나
echo    바탕화면에 UtilTools.exe 바로가기를 만들어 사용하시면 됩니다.
echo ========================================================
echo.
pause
