@echo off
chcp 65001 >nul
title vzlyot.post
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)

if not exist "backend\node_modules" (
  echo Installing server packages...
  call npm install --prefix backend --no-audit --no-fund || (pause & exit /b 1)
)
if not exist "local\node_modules" (
  echo Installing local database...
  call npm install --prefix local --no-audit --no-fund || (pause & exit /b 1)
)

node local\start.mjs
pause
