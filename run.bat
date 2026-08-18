@echo off
chcp 65001 > nul
cd /d "%~dp0"
set "BUN_EXE=bun"
where bun >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
"%BUN_EXE%" run src/server.ts
