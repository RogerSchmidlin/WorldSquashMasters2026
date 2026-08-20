@echo off
cd /d "%~dp0"
echo.
echo World Squash Masters - refresh tournament data
echo ================================================
echo.
if not exist node_modules (
  echo Installing Node packages for first use...
  call npm install || goto :error
)
call npx playwright install chromium || goto :error
call npm run refresh || goto :error
echo.
echo Refresh completed successfully.
echo Open index.html to view the updated website.
pause
exit /b 0
:error
echo.
echo Refresh failed. See any refresh-debug files in this folder.
pause
exit /b 1
