@echo off
rem Windows make entry (same targets as Makefile; implementation in scripts/ts/make-windows.ts).
rem Usage: make.cmd TARGET [KEY=VALUE ...]
setlocal
node "%~dp0scripts\ts\make-windows.ts" %*
exit /b %ERRORLEVEL%