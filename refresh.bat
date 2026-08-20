@echo off
cd /d "%~dp0"
echo Refreshing TournamentSoftware data only...
npm run refresh
if errorlevel 1 (
  echo.
  echo Refresh failed. data.js was not overwritten.
  pause
  exit /b 1
)
echo.
npm run check
echo.
echo Done. Only data.js needs uploading for a data-only update.
pause
