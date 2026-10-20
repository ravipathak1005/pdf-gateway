@echo off
REM Starts a tiny local web server and opens PDF Gateway in your browser.
cd /d "%~dp0"
where py >nul 2>nul && (start "" http://localhost:8765/index.html & py -m http.server 8765 & goto :eof)
where python >nul 2>nul && (start "" http://localhost:8765/index.html & python -m http.server 8765 & goto :eof)
echo Python is required for the local server (https://www.python.org). Or upload this folder to GitHub Pages.
pause
