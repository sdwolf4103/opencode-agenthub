@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "BUILT=%REPO_ROOT%\dist\composer\opencode-profile.js"

if exist "%BUILT%" (
  node "%BUILT%" %*
  exit /b %ERRORLEVEL%
)

if not exist "%REPO_ROOT%\node_modules" (
  >&2 echo [bin\opencode-agenthub] node_modules not found. Run 'bun install' first.
  exit /b 1
)

>&2 echo [bin\opencode-agenthub] dist\ not found. Building once before running...
pushd "%REPO_ROOT%" >nul
node scripts\build.mjs
set "BUILD_EXIT=%ERRORLEVEL%"
popd >nul
if not "%BUILD_EXIT%"=="0" exit /b %BUILD_EXIT%

node "%BUILT%" %*
