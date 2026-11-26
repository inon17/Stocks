@echo off
rem Starts the stocks P/L site and opens it in the browser. Close this window to stop.
cd /d "%~dp0"
start "" http://127.0.0.1:8000
python server.py
pause
