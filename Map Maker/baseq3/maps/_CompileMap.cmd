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

echo.
echo %BLD%%CYN% ===================================================%RST%
echo %BLD%%CYN%   Universal Quake 3 Compiler  ^(q3map2^)%RST%
echo %BLD%%CYN% ===================================================%RST%
echo %DIM%   Basepath : %BASEPATH%%RST%
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
echo  %YLW% [1]%RST% %BLD%DRAFT%RST%    - no bounce, fast geometry preview
echo       %DIM%  BSP + VIS (fast) + LIGHT (fast, no bounce, samplesize 8)%RST%
echo.
echo  %YLW% [2]%RST% %BLD%MEDIUM%RST%   - bounced light, good for iteration
echo       %DIM%  BSP + VIS (fast) + LIGHT (8 samples, 4 bounce, AO, samplesize 4)%RST%
echo.
echo  %YLW% [3]%RST% %BLD%FINAL%RST%    - full quality, slow
echo       %DIM%  BSP + VIS (full) + LIGHT (32 samples, 16 bounce, AO, samplesize 2)%RST%
echo %CYN% ---------------------------------------------------%RST%
echo %DIM%   Note: quality is controlled by samplesize, not lightmapsize.%RST%
echo %DIM%   Lower samplesize = sharper shadows. lightmapsize is left at%RST%
echo %DIM%   default (128) to avoid StoreSurfaceLightmaps errors.%RST%
echo %CYN% ---------------------------------------------------%RST%
set /p MODE_CHOICE="  Enter mode [1-3]: "

if "!MODE_CHOICE!"=="" set "MODE_CHOICE=2"
if "!MODE_CHOICE!" NEQ "1" if "!MODE_CHOICE!" NEQ "2" if "!MODE_CHOICE!" NEQ "3" (
    echo %RED%  Invalid choice, defaulting to MEDIUM.%RST%
    set "MODE_CHOICE=2"
)

set "MAPFILE=%~dp0!MAPNAME!.map"
set "BSPFILE=%~dp0!MAPNAME!.bsp"
set "SRFFILE=%~dp0!MAPNAME!.srf"

echo.
echo %BLD%%CYN% ===================================================%RST%
echo %WHT%   Map     :%RST% %YLW%!MAPNAME!.map%RST%
echo %WHT%   Basepath:%RST% %DIM%!BASEPATH!%RST%
if "!MODE_CHOICE!"=="1" echo %WHT%   Mode    :%RST% %DIM%DRAFT%RST%
if "!MODE_CHOICE!"=="2" echo %WHT%   Mode    :%RST% %CYN%MEDIUM%RST%
if "!MODE_CHOICE!"=="3" echo %WHT%   Mode    :%RST% %GRN%FINAL%RST%
echo %BLD%%CYN% ===================================================%RST%
echo.

:: --- [1/3] BSP ---
echo %BLD%%MAG% --- [1/3] BSP pass -----------------------------------%RST%
"%~dp0q3map2\q3map2" -meta -fs_basepath "!BASEPATH!" -fs_game baseq3 "!MAPFILE!"
if errorlevel 1 goto :error

:: --- [2/3] VIS ---
echo.
echo %BLD%%MAG% --- [2/3] VIS pass -----------------------------------%RST%
if "!MODE_CHOICE!"=="1" "%~dp0q3map2\q3map2" -vis -fast -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="2" "%~dp0q3map2\q3map2" -vis -fast -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="3" "%~dp0q3map2\q3map2" -vis -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if errorlevel 1 goto :error

:: --- [3/3] LIGHT ---
:: Quality is driven by -samplesize (luxel density in world units):
::   samplesize 8  = default, coarse (DRAFT)
::   samplesize 4  = 2x sharper shadows (MEDIUM)
::   samplesize 2  = 4x sharper shadows (FINAL)
:: -lightmapsize is intentionally omitted — this version of q3map2
:: triggers "Storing all lightmaps externally" + exit code 3 when it
:: is set above 128, regardless of map size.
echo.
echo %BLD%%MAG% --- [3/3] LIGHT pass ----------------------------------%RST%
if "!MODE_CHOICE!"=="1" "%~dp0q3map2\q3map2" -light -fast -samplesize 8 -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="2" "%~dp0q3map2\q3map2" -light -fast -samplesize 4 -samples 8 -bounce 4 -bouncescale 1.2 -patchshadows -dirty -randomsamples -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if "!MODE_CHOICE!"=="3" "%~dp0q3map2\q3map2" -light -samplesize 2 -samples 32 -bounce 16 -bouncescale 1.2 -patchshadows -dirty -randomsamples -filter -fs_basepath "!BASEPATH!" -fs_game baseq3 "!BSPFILE!"
if errorlevel 1 goto :error

if exist "!SRFFILE!" del /q "!SRFFILE!"

:: --- Texture report ---
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
echo %BLD%%RED%   ERROR: Compilation failed ^(exit code %ERRORLEVEL%^)%RST%
echo %BLD%%RED% ===================================================%RST%
pause
exit /b 1
