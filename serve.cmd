@echo off
echo Serving LOOPING at http://localhost:8080  (Ctrl+C to stop)
py -m http.server 8080 2>nul || python -m http.server 8080 2>nul || npx serve -l 8080 .
