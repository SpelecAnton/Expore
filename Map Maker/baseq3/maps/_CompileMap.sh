set -u

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\e[91m'
GRN=$'\e[92m'
YLW=$'\e[93m'
MAG=$'\e[95m'
CYN=$'\e[96m'
WHT=$'\e[97m'
DIM=$'\e[90m'
RST=$'\e[0m'
BLD=$'\e[1m'

# ── Paths ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASEPATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
Q3MAP2_LINUX="$SCRIPT_DIR/q3map2/q3map2"
Q3MAP2_WINE="$SCRIPT_DIR/q3map2/q3map2.exe"

THREADS="$(nproc 2>/dev/null || echo 4)"


Q3MAP2_CMD=()

resolve_q3map2() {
    local native_ok=0
    local missing=""

    if [ -f "$Q3MAP2_LINUX" ]; then
        [ -x "$Q3MAP2_LINUX" ] || chmod +x "$Q3MAP2_LINUX" 2>/dev/null
        missing="$(ldd "$Q3MAP2_LINUX" 2>/dev/null | awk '/not found/ {print $1}')"
        [ -z "$missing" ] && native_ok=1
    fi

    if [ "$native_ok" -eq 1 ]; then
        Q3MAP2_CMD=("$Q3MAP2_LINUX")
        return 0
    fi

    if [ -f "$Q3MAP2_WINE" ] && command -v wine >/dev/null 2>&1; then
        echo "${YLW}   Native Linux q3map2 unavailable — falling back to Wine (q3map2.exe).${RST}"
        Q3MAP2_CMD=(wine "$Q3MAP2_WINE")
        return 0
    fi

    echo "${RED}   Could not find a working q3map2.${RST}"
    if [ -n "$missing" ]; then
        echo "${RED}   $Q3MAP2_LINUX is missing shared libraries:${RST}"
        while IFS= read -r lib; do
            echo "${RED}     - $lib${RST}"
        done <<< "$missing"
        echo "${DIM}   These are often from a very old 32-bit q3map2 build; libraries${RST}"
        echo "${DIM}   like libmhash.so.2 or libstdc++.so.5 are no longer packaged by${RST}"
        echo "${DIM}   modern distros, so installing them normally is not an option.${RST}"
        echo
        echo "${DIM}   Two ways forward:${RST}"
        echo "${DIM}     1) Get a modern 64-bit Linux q3map2 build (e.g. from a${RST}"
        echo "${DIM}        netradiant-custom release) and place it at:${RST}"
        echo "${DIM}          $Q3MAP2_LINUX${RST}"
        echo "${DIM}     2) Keep the old Windows q3map2.exe, install Wine, and place${RST}"
        echo "${DIM}        the .exe at:${RST}"
        echo "${DIM}          $Q3MAP2_WINE${RST}"
    elif [ ! -f "$Q3MAP2_LINUX" ] && [ ! -f "$Q3MAP2_WINE" ]; then
        echo "${DIM}   No binary found at either:${RST}"
        echo "${DIM}     $Q3MAP2_LINUX${RST}"
        echo "${DIM}     $Q3MAP2_WINE${RST}"
    elif [ -f "$Q3MAP2_WINE" ]; then
        echo "${DIM}   Found $Q3MAP2_WINE but Wine is not installed.${RST}"
        echo "${DIM}   Debian/Ubuntu : sudo apt install wine${RST}"
        echo "${DIM}   Arch          : sudo pacman -S wine${RST}"
        echo "${DIM}   Fedora        : sudo dnf install wine${RST}"
    fi
    exit 1
}

cleanup_tmp() {
    rm -f "$SCRIPT_DIR/tex_unsorted.tmp" "$SCRIPT_DIR/tex_sorted.tmp"
}

fail() {
    cleanup_tmp
    echo
    echo "${BLD}${RED} ===================================================${RST}"
    echo "${BLD}${RED}   ERROR: Compilation failed${RST}"
    echo "${BLD}${RED} ===================================================${RST}"
    exit 1
}

echo
echo "${BLD}${CYN} ===================================================${RST}"
echo "${BLD}${CYN}   EXPORE Map Compiler (q3map2) ${RST}"
echo "${BLD}${CYN} ===================================================${RST}"
echo "${DIM}   Basepath : $BASEPATH${RST}"
echo "${DIM}   Threads  : $THREADS (auto-detected)${RST}"
echo "${CYN} ---------------------------------------------------${RST}"
echo "${WHT}   Maps found in this folder:${RST}"
echo "${CYN} ---------------------------------------------------${RST}"

# ── Collect .map files in this folder ───────────────────────────────────────
maps=()
while IFS= read -r -d '' f; do
    maps+=("$(basename "$f" .map)")
done < <(find "$SCRIPT_DIR" -maxdepth 1 -name '*.map' -print0 | sort -z)

if [ "${#maps[@]}" -eq 0 ]; then
    echo "${RED}   No .map files found!${RST}"
    echo "${CYN} ===================================================${RST}"
    exit 1
fi

index=0
for m in "${maps[@]}"; do
    index=$((index + 1))
    echo " ${YLW} [$index]${RST} $m"
done

echo "${CYN} ---------------------------------------------------${RST}"
echo
read -r -p "  Enter map number [1-$index]: " choice

if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "$index" ]; then
    echo "${RED}  Invalid choice.${RST}"
    exit 1
fi

MAPNAME="${maps[$((choice - 1))]}"

echo
echo "${BLD}${CYN} ===================================================${RST}"
echo "${BLD}${WHT}   Select compile mode:${RST}"
echo "${CYN} ---------------------------------------------------${RST}"
echo " ${YLW} [1]${RST} ${BLD}PREVIEW${RST}"
echo "      ${DIM}  Use this when you only use ambient light${RST}"
echo
echo " ${YLW} [2]${RST} ${BLD}MEDIUM${RST}"
echo "      ${DIM}  Very solid lights${RST}"
echo
echo " ${YLW} [3]${RST} ${RED}EXTREME${RST}"
echo "      ${DIM}  Intended for final version${RST}"
echo
echo "${CYN} ---------------------------------------------------${RST}"
echo "${DIM}   All modes use -threads $THREADS for parallel light computation.${RST}"
echo "${CYN} ---------------------------------------------------${RST}"
read -r -p "  Enter mode [1-3]: " MODE_CHOICE

if [ -z "$MODE_CHOICE" ]; then
    MODE_CHOICE=3
fi
if [ "$MODE_CHOICE" != "1" ] && [ "$MODE_CHOICE" != "2" ] && [ "$MODE_CHOICE" != "3" ]; then
    echo "${RED}  Invalid choice, defaulting to PREVIEW.${RST}"
    MODE_CHOICE=1
fi

MAPFILE="$SCRIPT_DIR/$MAPNAME.map"
BSPFILE="$SCRIPT_DIR/$MAPNAME.bsp"
SRFFILE="$SCRIPT_DIR/$MAPNAME.srf"
EXPOREFILE="$SCRIPT_DIR/$MAPNAME.expore"

echo
echo "${BLD}${CYN} ===================================================${RST}"
echo "${WHT}   Map     :${RST} ${YLW}$MAPNAME.map${RST}"
echo "${WHT}   Basepath:${RST} ${DIM}$BASEPATH${RST}"
echo "${WHT}   Threads :${RST} ${CYN}$THREADS${RST}"
case "$MODE_CHOICE" in
    1) echo "${WHT}   Mode    :${RST} ${DIM}PREVIEW${RST}" ;;
    2) echo "${WHT}   Mode    :${RST} ${DIM}MEDIUM${RST}" ;;
    3) echo "${WHT}   Mode    :${RST} ${RED}FINAL${RST}" ;;
esac
echo "${BLD}${CYN} ===================================================${RST}"
echo

resolve_q3map2

echo "${BLD}${MAG} --- [1/4] BSP pass -----------------------------------${RST}"
"${Q3MAP2_CMD[@]}" -meta -patchmeta -np 45 -mergemodels -maxmapdrawsurfs 524288 \
    -fs_basepath "$BASEPATH" -fs_game baseq3 "$MAPFILE" || fail

echo
echo "${BLD}${MAG} --- [2/4] VIS pass -----------------------------------${RST}"
case "$MODE_CHOICE" in
    1) "${Q3MAP2_CMD[@]}" -vis -fast -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail ;;
    2) "${Q3MAP2_CMD[@]}" -vis -fast -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail ;;
    3) "${Q3MAP2_CMD[@]}" -vis -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail ;;
esac

echo
echo "${BLD}${MAG} --- [3/4] LIGHT pass ----------------------------------${RST}"
case "$MODE_CHOICE" in
    1)
        "${Q3MAP2_CMD[@]}" -light -fast -threads "$THREADS" -samplesize 16 -samples 1 -bounce 0 \
            -dirty -randomsamples -filter -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail
        ;;
    2)
        "${Q3MAP2_CMD[@]}" -light -threads "$THREADS" -samplesize 8 -samples 2 -bounce 2 -bouncescale 0.8 \
            -dirty -randomsamples -filter -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail
        ;;
    3)
        "${Q3MAP2_CMD[@]}" -light -threads "$THREADS" -samplesize 8 -samples 4 -bounce 4 -bouncescale 0.6 \
            -dirty -randomsamples -filter -fs_basepath "$BASEPATH" -fs_game baseq3 "$BSPFILE" || fail
        ;;
esac

[ -f "$SRFFILE" ] && rm -f "$SRFFILE"

echo
echo "${BLD}${MAG} --- [4/4] Compressing to .expore -----------------------${RST}"
if [ ! -f "$BSPFILE" ]; then
    echo "${RED}   $BSPFILE not found — skipping .expore compression.${RST}"
elif command -v gzip >/dev/null 2>&1; then
    if gzip -9 -c "$BSPFILE" > "$EXPOREFILE"; then
        BSP_SIZE=$(du -h "$BSPFILE" | cut -f1)
        EXPORE_SIZE=$(du -h "$EXPOREFILE" | cut -f1)
        echo "${GRN}   Created: $MAPNAME.expore  ($BSP_SIZE -> $EXPORE_SIZE)${RST}"
    else
        rm -f "$EXPOREFILE"
        echo "${RED}   gzip compression failed — $MAPNAME.bsp is still usable uncompressed.${RST}"
    fi
else
    echo "${YLW}   gzip not found — skipping .expore compression.${RST}"
    echo "${DIM}   Debian/Ubuntu : sudo apt install gzip${RST}"
    echo "${DIM}   Arch          : sudo pacman -S gzip${RST}"
    echo "${DIM}   Fedora        : sudo dnf install gzip${RST}"
    echo "${DIM}   The engine can still load $MAPNAME.bsp directly, uncompressed.${RST}"
fi

echo
echo "${BLD}${CYN} ===================================================${RST}"
echo "${BLD}${WHT}   Textures referenced in $MAPNAME.map${RST}"
echo "${CYN} ---------------------------------------------------${RST}"
echo "${WHT}   Copy these files to your server texture folder:${RST}"
echo "${CYN} ---------------------------------------------------${RST}"

TEMP_TEX_FILE="$SCRIPT_DIR/tex_unsorted.tmp"
SORTED_TEX_FILE="$SCRIPT_DIR/tex_sorted.tmp"
rm -f "$TEMP_TEX_FILE" "$SORTED_TEX_FILE"

awk '
    $1=="(" && $5==")" && $6=="(" && $10==")" && $11=="(" && $15==")" {
        print $16
    }
' "$MAPFILE" | sed 's#^textures/##' | sort -u > "$SORTED_TEX_FILE"

TEXCOUNT=0
if [ -s "$SORTED_TEX_FILE" ]; then
    while IFS= read -r texline; do
        TEXCOUNT=$((TEXCOUNT + 1))
        echo " ${YLW} [$TEXCOUNT]${RST} $texline"
    done < "$SORTED_TEX_FILE"
fi

cleanup_tmp

if [ "$TEXCOUNT" -eq 0 ]; then
    echo "${DIM}   (no textures found)${RST}"
fi

echo
echo "${CYN} ---------------------------------------------------${RST}"
echo "${DIM}   Total: $TEXCOUNT unique textures${RST}"
echo
echo "${BLD}${GRN} ===================================================${RST}"
echo "${BLD}${GRN}   Compilation complete!${RST}"
echo "${BLD}${GRN}   Made by SPELEC.CZ${RST}"
echo "${BLD}${GRN} ===================================================${RST}"
exit 0
