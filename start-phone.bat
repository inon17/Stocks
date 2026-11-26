@echo off
rem Starts the stocks P/L site for this PC AND phones on the same Wi-Fi.
rem The phone address is printed in this window. Close this window to stop.
cd /d "%~dp0"
start "" http://127.0.0.1:8000
python server.py --lan
pause
