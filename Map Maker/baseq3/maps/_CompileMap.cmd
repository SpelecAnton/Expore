@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

for /f %%A in ('echo prompt $E ^| cmd') do set "ESC=%%A"

set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YLW=%ESC%[93m"
set "MAG=%ESC%[95m"
set "CYN=%ESC%[96m"
set "WHT=%ESC%[97m"
set "DIM=%ESC%[90m"
set "RST=%ESC%[0m"
set "BLD=%ESC%[1m"

pushd "%~dp0"
cd ..\..
set "BASEPATH=%CD%"
popd

set "THREADS=%NUMBER_OF_PROCESSORS%"
if "%THREADS%"=="" set "THREADS=4"

echo.
echo %BLD%%CYN% ===================================================%RST%
echo %BLD%%CYN%   EXPORE Map Compiler (q3map2) %RST%
echo %BLD%%CYN% ===================================================%RST%
echo %DIM%   Basepath : %BASEPATH%%RST%
echo %DIM%   Threads  : %THREADS% (auto-detected)%RST%
echo %CYN% ---------------------------------------------------%RST%
echo %WHT%   Maps found in this folder:%RST%
echo %CYN% ---------------------------------------------------%RST%

set INDEX=0
for %%F in ("%~dp0*.map") do (
    set /a INDEX+=1
    set "MAP_!INDEX!=%%~nF"
    call echo  %YLW% [!INDEX!]%RST% %%~nF
)

if %INDEX%==0 (
    echo %RED%   No .map files found^^!%RST%
    echo %CYN% ===================================================%RST%
    pause
    exit /b 1
)

echo %CYN% ---------------------------------------------------%RST%
echo.
set /p CHOICE="  Enter map number [1-%INDEX%]: "

set "MAPNAME="
for /l %%i in (1,1,%INDEX%) do (
    if "%%i"=="!CHOICE!" set "MAPNAME=!MAP_%%i!"
)

if "!MAPNAME!"=="" (
    echo %RED%  Invalid choice.%RST%
    pause
    exit /b 1
)

echo.
echo %BLD%%CYN% ===================================================%RST%
echo %BLD%%WHT%   Select compile mode:%RST%
echo %CYN% ---------------------------------------------------%RST%
echo  %YLW% [1]%RST% %BLD%PREVIEW%RST%
echo       %DIM%  Use this when you only use ambient light%RST%
echo.
echo  %YLW% [2]%RST% %BLD%MEDIUM%RST%
echo       %DIM%  Very solid lights%RST%
echo.
echo  %YLW% [3]%RST% %RED%EXTREME%RST%
echo       %DIM%  Intended for final version%RST%
echo.
echo %CYN% ---------------------------------------------------%RST%
echo %DIM%   All modes use -threads %THREADS% for parallel light computation.%RST%
echo %CYN% ---------------------------------------------------%RST%
set /p MODE_CHOICE="  Enter mode [1-5]: "

if "!MODE_CHOICE!"=="" set "MODE_CHOICE=3"
if "!MODE_CHOICE!" NEQ "1" if "!MODE_CHOICE!" NEQ "2" if "!MODE_CHOICE!" NEQ "3" (
    echo %RED%  Invalid choice, defaulting to PREVIEW.%RST%
    set "MODE_CHOICE=1"
)

set "MAPFILE=%~dp0!MAPNAME!.map"
set "BSPFILE=%~dp0!MAPNAME!.bsp"
set "GZFILE=%~dp0!MAPNAME!.expore"
set "SRFFILE=%~dp0!MAPNAME!.srf"

echo.
echo %BLD%%CYN% ===================================================%RST%
echo %WHT%   Map     :%RST% %YLW%!MAPNAME!.map%RST%
echo %WHT%   Basepath:%RST% %DIM%!BASEPATH!%RST%
echo %WHT%   Threads :%RST% %CYN%!THREADS!%RST%
if "!MODE_CHOICE!"=="1" echo %WHT%   Mode    :%RST% %DIM%PREVIEW%RST%
if "!MODE_CHOICE!"=="2" echo %WHT%   Mode    :%RST% %DIM%MEDIUM%RST%
if "!MODE_CHOICE!"=="3" echo %WHT%   Mode    :%RST% %RED%FINAL%RST%
echo %BLD%%CYN% ===================================================%RST%
echo.

echo %BLD%%MAG% --- [1/4] BSP pass -----------------------------------%RST%
"%~dp0q3map2\q3map2" -meta -patchmeta -np 45 -maxmapdrawsurfs 524288 -fs_basepath "!BASEPATH!" -fs_game baseq3 "!MAPFILE!"
if errorlevel 1 goto :error

echo.
echo %BLD%%MAG% --- [2/4] VIS pass -----------------------------------%RST%
if "!MODE_CHOICE!"=="1" "%~dp0q3map2\q3map2" -vis -fast -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="2" "%~dp0q3map2\q3map2" -vis -fast -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="3" "%~dp0q3map2\q3map2" -vis -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if errorlevel 1 goto :error

echo.
echo %BLD%%MAG% --- [3/4] LIGHT pass ----------------------------------%RST%

if "!MODE_CHOICE!"=="1" (
    "%~dp0q3map2\q3map2" -light -fast -threads !THREADS! -samplesize 16 -samples 1 -bounce 0 -dirty -randomsamples -filter -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
)

if "!MODE_CHOICE!"=="2" (
    "%~dp0q3map2\q3map2" -light -threads !THREADS! -samplesize 8 -samples 2 -bounce 2 -bouncescale 0.8 -dirty -randomsamples -filter -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
)

if "!MODE_CHOICE!"=="3" (
    "%~dp0q3map2\q3map2" -light -threads !THREADS! -samplesize 8 -samples 4 -bounce 4 -bouncescale 0.6 -dirty -randomsamples -filter -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
)

if errorlevel 1 goto :error

if exist "!SRFFILE!" del /q "!SRFFILE!"

echo.
echo %BLD%%MAG% --- [4/4] Compressing ------------%RST%
echo %DIM%   Creating !MAPNAME!.expore file%RST%

:: Pass the path via environment variable to avoid all cmd escaping nightmares
:: with backslashes and percent signs inside the PowerShell -Command string.
set "BSPPATH=!BSPFILE!"
set "GZPATH=!GZFILE!"

powershell -NoProfile -NonInteractive -Command ^
  "$s=$env:BSPPATH; $d=$env:GZPATH;" ^
  "try {" ^
  "  $i=[IO.File]::OpenRead($s);" ^
  "  $o=[IO.File]::Create($d);" ^
  "  $g=[IO.Compression.GZipStream]::new($o,[IO.Compression.CompressionLevel]::Optimal);" ^
  "  $i.CopyTo($g); $g.Close(); $o.Close(); $i.Close();" ^
  "  $a=[IO.FileInfo]::new($s).Length;" ^
  "  $b=[IO.FileInfo]::new($d).Length;" ^
  "  $ratio=[Math]::Round((1-$b/$a)*100,1);" ^
  "  Write-Host ('     BSP: '+[Math]::Round($a/1MB,2)+' MB');" ^
  "  Write-Host ('  Expore: '+[Math]::Round($b/1MB,2)+' MB  ('+$ratio+' pcnt smaller)');" ^
  "} catch { Write-Host ('  WARN: gzip failed — '+$_.Exception.Message); exit 0 }"


echo.
echo %BLD%%CYN% ===================================================%RST%
echo %BLD%%WHT%   Textures referenced in !MAPNAME!.map%RST%
echo %CYN% ---------------------------------------------------%RST%
echo %WHT%   Copy these files to your server texture folder:%RST%
echo %CYN% ---------------------------------------------------%RST%

set "TEMP_TEX_FILE=%~dp0tex_unsorted.tmp"
set "SORTED_TEX_FILE=%~dp0tex_sorted.tmp"

if exist "!TEMP_TEX_FILE!" del "!TEMP_TEX_FILE!"
if exist "!SORTED_TEX_FILE!" del "!SORTED_TEX_FILE!"

for /f "usebackq tokens=1,5,6,10,11,15,16" %%A in ("!MAPFILE!") do (
    if "%%A"=="(" if "%%B"==")" if "%%C"=="(" if "%%D"==")" if "%%E"=="(" if "%%F"==")" (
        set "TEX=%%G"
        set "TEX=!TEX:textures/=!"
        if not defined TEX_DUP_!TEX! (
            set "TEX_DUP_!TEX!=1"
            echo !TEX!>>"!TEMP_TEX_FILE!"
        )
    )
)

set TEXCOUNT=0
if exist "!TEMP_TEX_FILE!" (
    sort "!TEMP_TEX_FILE!" /o "!SORTED_TEX_FILE!"
    for /f "usebackq delims=" %%S in ("!SORTED_TEX_FILE!") do (
        set /a TEXCOUNT+=1
        set "TEXLINE=%%S"
        call :printTex
    )
    del "!TEMP_TEX_FILE!"
    del "!SORTED_TEX_FILE!"
)

if !TEXCOUNT!==0 echo %DIM%   (no textures found)%RST%

echo.
echo %CYN% ---------------------------------------------------%RST%
echo %DIM%   Total: !TEXCOUNT! unique textures%RST%
echo.
echo %BLD%%GRN% ===================================================%RST%
echo %BLD%%GRN%   Compilation complete^^!%RST%
echo %BLD%%GRN%   Made by SPELEC.CZ
echo %BLD%%GRN% ===================================================%RST%
pause
exit /b 0

:printTex
echo  %YLW% [%TEXCOUNT%]%RST% %TEXLINE%
exit /b 0

:error
if exist "%~dp0tex_unsorted.tmp" del "%~dp0tex_unsorted.tmp"
if exist "%~dp0tex_sorted.tmp" del "%~dp0tex_sorted.tmp"
echo.
echo %BLD%%RED% ===================================================%RST%
echo %BLD%%RED%   ERROR: Compilation failed (exit code %ERRORLEVEL%)%RST%
echo %BLD%%RED% ===================================================%RST%
pause
exit /b 1
